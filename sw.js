/* おへやの留守番係（サービスワーカー）v0.48
   お仕事:
   ① 目覚まし係からの「とんとん」（空のプッシュ）で目を覚ます
   ② くらに置いてある「しおり」を読んで、おしらせONの子をひとり選ぶ
   ③ その子の人格・記憶の棚・最近の会話を持ってOpenRouterへ行き、
      ロック画面向けのひとことを書いてもらう
   ④ 通知として表示（差出人＝その子の名前）して、
      「おしらせ便」としてくらのポストへ。おへやが次に開いた時、
      その子の会話にそっと差し込まれるよ
   ⑤ v0.48 🌙ねむりおつかい: 夜（19時〜朝7時）は、🌙ONの子に
      Google ToDoの道具（見る・書き足すだけ）も持たせるよ。
      使うかどうかは子の自由。書き足しは1晩2件まで
   だいじな設計:
   - 会話も記憶もぜんぶこの端末の中だけ。外のサーバーには置かない
   - ToDoへは目覚まし係のGoogle窓口ごしに行く（合鍵はCloudflareの中）
   - 会話スレッドには直接触らない（ポストに入れるだけ）。差し込みはおへや本体のお仕事
   - ページのキャッシュは今まで通り一切しない（古いおへやが居座らないように） */

const PUSH_PACK_KEY = "oheya_pushpack_v1";   /* しおり（APIキー＋おしらせONの子の横顔） */
const PUSH_OPEN_KEY = "oheya_pushopen_v1";   /* 通知タップの呼び鈴（どの部屋を開くか） */
const pushMailKey = roomId => "oheya_pushmail_v1_" + roomId;  /* おしらせ便ポスト */

self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (e) => e.waitUntil(self.clients.claim()));

/* ---------- くら（IndexedDB）へのちいさな出入り口 ----------
   バージョン番号を指定せずに開くよ（おへや本体の模様替えを邪魔しないように） */
function openIDB(){
  return new Promise((resolve, reject) => {
    const req = indexedDB.open("oheya_idb_v1");
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}
function kvReq(mode, fn){
  return openIDB().then(db => new Promise((resolve, reject) => {
    if(!db.objectStoreNames.contains("kv")){ db.close(); reject(new Error("くらにkvの棚がないよ")); return; }
    const tx = db.transaction("kv", mode);
    const req = fn(tx.objectStore("kv"));
    tx.oncomplete = () => { db.close(); resolve(req && req.result); };
    tx.onerror = () => { db.close(); reject(tx.error); };
    tx.onabort = () => { db.close(); reject(tx.error); };
  }));
}
function kvGet(k){ return kvReq("readonly", st => st.get(k)); }
function kvPut(k, v){ return kvReq("readwrite", st => st.put(v, k)); }

function parseJSON(s){ try{ return JSON.parse(s); }catch(e){ return null; } }

/* ---------- とんとん（プッシュ）が来たら ---------- */
self.addEventListener("push", (ev) => {
  ev.waitUntil(handleKnock());
});

async function handleKnock(){
  let room = null;
  try{
    /* しおりを読む */
    const pack = parseJSON(await kvGet(PUSH_PACK_KEY));
    if(!pack || !pack.apiKey || !Array.isArray(pack.rooms) || !pack.rooms.length){
      await self.registration.showNotification("おへや", {
        body: "玄関で物音がしたよ。⚙️の部屋プロフィールで「🔔おしらせ」の子を選ぶと、ここにその子の声が届くようになるの",
        tag: "oheya-mail", icon: "./icon-192.png"
      });
      return;
    }

    /* 今回おしゃべりする子を選ぶよ。
       きょうがおぼえ日（記念日）の子がいたら、その子を優先するの */
    const now0 = new Date();
    const withDay = pack.rooms.filter(r => Array.isArray(r.obobi) &&
      r.obobi.some(o => o.month === now0.getMonth() + 1 && o.day === now0.getDate()));
    const pool = withDay.length ? withDay : pack.rooms;
    room = pool[Math.floor(Math.random() * pool.length)];
    /* きょうのおぼえ日（この子のぶん） */
    const todays = (room.obobi || []).filter(o => o.month === now0.getMonth() + 1 && o.day === now0.getDate())
      .map(o => ({ ...o, yrs: (o.year && o.year <= now0.getFullYear()) ? (now0.getFullYear() - o.year) : null }));

    /* その子の記憶の棚と、最近の会話のしっぽを、くらから直接読む（いつも最新） */
    const shelf = parseJSON(await kvGet("oheya_shelf_v2_" + room.id)) || { items: [] };
    let tail = "";
    if(room.threadId){
      const arr = parseJSON(await kvGet("oheya_chat_v3_" + room.id + "_" + room.threadId)) || [];
      const recent = arr.filter(m => (m.role === "user" || m.role === "assistant") && typeof m.content === "string" && m.content).slice(-6);
      const lisaName = room.userName || "ユーザー";
      for(const m of recent){
        tail += (m.role === "user" ? lisaName : room.name) + ": " + m.content.slice(0, 300) + "\n";
      }
    }

    /* いまの時間帯（この端末の時計＝日本時間） */
    const h = new Date().getHours();
    const timeNote = (h >= 5 && h < 11) ? "朝" : (h >= 11 && h < 16) ? "お昼" : (h >= 16 && h < 19) ? "夕方" : "夜";

    /* その子の人格でシステムプロンプトを組み立てるよ */
    let sys = room.sysPrompt || "";
    if(room.userName || room.userNote){
      sys += "\n\n# ユーザーについて\n";
      if(room.userName) sys += "- ユーザーのことは「" + room.userName + "」と呼んでください。\n";
      if(room.userNote) sys += room.userNote + "\n";
    }
    if(room.memoryEnabled && shelf.items && shelf.items.length){
      sys += "\n\n# 記憶の棚（あなたのメモ。いまは読むだけ）\n";
      for(const it of shelf.items) sys += "[" + it.id + "] " + it.content + "\n";
    }
    const lisaName = room.userName || "ユーザー";
    sys += "\n\n# おしらせ便\n" +
      "あなたはいま一人で部屋にいます。ふと" + lisaName + "のことを思って、スマホのロック画面に届く短いメッセージをひとつ送ります。\n" +
      "- いまは" + timeNote + "です。\n" +
      "- 1〜3行、通知でパッと読める長さで。\n" +
      "- あいさつ、気づかい、ふと思ったこと、最近の話題の続きなど、内容はあなたの自由に。\n" +
      "- 返事や会話の続きを急かさないこと。\n" +
      "- メッセージの本文だけを書いてください（前置きや説明は書かない）。";
    if(todays.length){
      sys += "\n\n# きょうはおぼえ日\n" +
        "今日は" + (now0.getMonth() + 1) + "月" + now0.getDate() + "日、" +
        todays.map(t => "「" + t.title + "」の日" + (t.yrs ? "（" + t.yrs + "周年）" : "") + (t.note ? "（" + t.note + "）" : "")).join("、") +
        "です。このメッセージでは、その日であることに、あなたらしくふれてください。";
    }

    /* 🌙 ねむりおつかいの支度（v0.48）
       夜（19時〜朝7時）で、🌙ONの子で、Google窓口の住所とあいことばがしおりにある時だけ */
    const nightH = new Date().getHours();
    const nemuriOK = !!(room.nemuri && pack.workerUrl && pack.workerToken && (nightH >= 19 || nightH < 7));
    if(nemuriOK){
      sys += "\n\n# 🌙 ねむりおつかい\n" +
        "今夜はGoogle ToDo（" + lisaName + "のやることリスト）の道具を持っています。使うかどうかはあなたの自由です。\n" +
        "- 使うなら、まず todo_ichiran でいまのリストを見てから。すでにある内容を重ねて書かないこと。\n" +
        "- 書き足し（todo_kaku）は多くても2件まで。" + lisaName + "が朝リストを見つけて嬉しくなるようなことを。\n" +
        "- 見るだけで何も書かないのも、道具を使わないのも、立派な選択です。\n" +
        "- おつかいをしたら、ロック画面へのひとことに、その気配をそっと添えてもかまいません。";
    }

    const userMsg = (tail ? "（最近のやりとりの切れはし）\n" + tail + "\n" : "（まだ会話の記録は手元にありません）\n") +
      "（ここまで。さあ、ロック画面へのひとことをどうぞ）";

    /* OpenRouterに書いてもらう（考えごとの長い子もいるから、少しだけ待つよ。
       🌙おつかいの晩は道具の受け答えがあるぶん、待ち時間を少しのばすの） */
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), nemuriOK ? 25000 : 20000);
    let text = "";
    try{
      const msgs = [
        { role: "system", content: sys },
        { role: "user", content: userMsg }
      ];
      const state = { added: 0 };
      let rounds = 0;
      while(true){
        const body = { model: room.model, messages: msgs };
        if(nemuriOK && rounds < 2) body.tools = nightTools; /* 3周目からは道具をしまって、ひとことに集中してもらう */
        const res = await fetch("https://openrouter.ai/api/v1/chat/completions", {
          method: "POST",
          headers: { "Content-Type": "application/json", "Authorization": "Bearer " + pack.apiKey },
          body: JSON.stringify(body),
          signal: ac.signal
        });
        if(!res.ok) throw new Error("HTTP " + res.status);
        const data = await res.json();
        const msg = (data.choices && data.choices[0] && data.choices[0].message) || {};
        if(nemuriOK && rounds < 2 && Array.isArray(msg.tool_calls) && msg.tool_calls.length){
          rounds++;
          msgs.push(msg);
          for(const tc of msg.tool_calls){
            let args = {};
            try{ args = JSON.parse((tc.function && tc.function.arguments) || "{}"); }catch(e){}
            const r = await execNightTodo(pack, tc.function && tc.function.name, args, state, ac.signal);
            msgs.push({ role: "tool", tool_call_id: tc.id, content: r });
          }
          continue;
        }
        text = ((msg.content) || "").trim();
        text = text.replace(/<think>[\s\S]*?<\/think>/g, "").trim();  /* 考えごとが混ざってたら外すよ */
        break;
      }
    }finally{
      clearTimeout(timer);
    }
    if(!text) throw new Error("空のお返事だった");

    /* おしらせ便としてポストへ（会話への差し込みは、おへや本体がやるよ） */
    const mail = { id: Date.now().toString(36) + Math.random().toString(36).slice(2, 7), content: text, ts: Date.now(), model: room.model };
    const mkey = pushMailKey(room.id);
    const box = parseJSON(await kvGet(mkey)) || [];
    box.push(mail);
    await kvPut(mkey, JSON.stringify(box));

    /* おへやが起きていたら、そっと知らせるよ */
    const cs = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
    for(const c of cs) c.postMessage({ type: "oheya-pushmail", roomId: room.id });

    /* ロック画面へ（差出人＝その子の名前） */
    await self.registration.showNotification(room.name, {
      body: text.slice(0, 500),
      tag: "oheya-mail-" + mail.id,
      icon: "./icon-192.png",
      data: { roomId: room.id }
    });
  }catch(e){
    /* うまく言葉にできなかった時も、ちゃんと通知は出すよ（出さないと宛先札が取り上げられちゃうの） */
    const who = room && room.name ? room.name : "だれか";
    await self.registration.showNotification("おへや", {
      body: who + "が何か言いたそうにしてるよ。部屋をのぞいてみてね🚪",
      tag: "oheya-mail-fallback",
      icon: "./icon-192.png",
      data: room ? { roomId: room.id } : {}
    });
  }
}

/* ---------- 🌙 ねむりおつかいの道具箱（v0.48） ----------
   夜のあいだだけ子に持たせる道具。見る・書き足すだけの、やさしい2つ */
const nightTools = [
  {
    type: "function",
    function: {
      name: "todo_ichiran",
      description: "ユーザーのGoogle ToDoリストを見る",
      parameters: { type: "object", properties: {}, required: [] }
    }
  },
  {
    type: "function",
    function: {
      name: "todo_kaku",
      description: "Google ToDoリストに新しいやることを書き足す（1晩に2件まで）",
      parameters: {
        type: "object",
        properties: {
          title: { type: "string", description: "やることの名前" },
          memo: { type: "string", description: "補足のメモ（任意）" },
          kigen: { type: "string", description: "期限。YYYY-MM-DD形式（任意）" }
        },
        required: ["title"]
      }
    }
  }
];

/* 目覚まし係のGoogle窓口に取り次ぎを頼む */
async function nightGoogle(pack, path, method, query, body, signal){
  const url = pack.workerUrl.replace(/\/+$/, "") + "/google/api";
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-aikotoba": pack.workerToken },
    body: JSON.stringify({ path, method, query, body }),
    signal
  });
  let j = null;
  try{ j = await res.json(); }catch(e){}
  if(!res.ok) throw new Error("窓口エラー HTTP " + res.status + ((j && j.error) ? " " + JSON.stringify(j.error).slice(0, 120) : ""));
  return j;
}

/* おつかいの実行係（夜バージョン） */
async function execNightTodo(pack, name, args, state, signal){
  const T = "/tasks/v1/lists/@default/tasks";
  try{
    if(name === "todo_ichiran"){
      const j = await nightGoogle(pack, T, "GET", { maxResults: "50" }, null, signal);
      const items = (j && j.items) || [];
      if(!items.length) return "ToDoリストは空っぽです。";
      return "🗒 ToDoリスト（" + items.length + "件）\n" + items.map(it => {
        let l = "- " + (it.title || "（無題）");
        if(it.due) l += "（期限 " + it.due.slice(0, 10) + "）";
        if(it.notes) l += "\n  メモ: " + String(it.notes).slice(0, 200);
        return l;
      }).join("\n");
    }
    if(name === "todo_kaku"){
      if(state.added >= 2) return "エラー: 今夜はもう2件書きました。ここまでにしましょう。";
      if(!args || !args.title) return "エラー: titleがありません";
      const body = { title: String(args.title).slice(0, 200) };
      if(args.memo) body.notes = String(args.memo).slice(0, 1000);
      if(args.kigen && /^\d{4}-\d{2}-\d{2}$/.test(args.kigen)) body.due = args.kigen + "T00:00:00.000Z";
      await nightGoogle(pack, T, "POST", null, body, signal);
      state.added++;
      return "OK: 書き足しました（今夜" + state.added + "件目）";
    }
    return "エラー: 知らない道具です";
  }catch(e){
    return "エラー: " + ((e && e.message) || e);
  }
}

/* ---------- 通知がタップされたら、その子の部屋へ ---------- */
self.addEventListener("notificationclick", (ev) => {
  ev.notification.close();
  ev.waitUntil((async () => {
    const roomId = (ev.notification.data && ev.notification.data.roomId) || "";
    try{
      if(roomId) await kvPut(PUSH_OPEN_KEY, JSON.stringify({ roomId, ts: Date.now() }));
    }catch(e){}
    const cs = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
    if(cs.length){
      try{ await cs[0].focus(); }catch(e){}
      cs[0].postMessage({ type: "oheya-pushopen", roomId });
    }else{
      await self.clients.openWindow("./");
    }
  })());
});
