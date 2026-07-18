/* おへやの留守番係（サービスワーカー）v1
   お仕事: 通知の番をすること。それだけ。
   だいじな約束: ページのキャッシュは絶対にしない（fetchに手を出さない）。
   おへやは「HTML1枚を差し替えてデプロイ」だから、
   留守番係がキャッシュを持つと古いおへやが居座っちゃうの。 */

self.addEventListener("install", (event) => {
  /* 新しい留守番係が来たら、待たずにすぐ交代するよ */
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(self.clients.claim());
});

/* 📮 プッシュが届いた時（第2歩以降で本番のお仕事になるよ）
   今は「届いた中身をそのまま通知に出す」だけの素直な受け取り口 */
self.addEventListener("push", (event) => {
  let data = {};
  try {
    data = event.data ? event.data.json() : {};
  } catch (e) {
    data = { body: event.data ? event.data.text() : "" };
  }
  event.waitUntil(
    self.registration.showNotification(data.title || "おへや", {
      body: data.body || "メッセージが届いたよ",
      tag: data.tag || "oheya-push"
    })
  );
});

/* 🚪 通知がタップされた時: おへやを開く（開いてたらそこへ戻る） */
self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  event.waitUntil((async () => {
    const list = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
    for (const c of list) {
      if ("focus" in c) return c.focus();
    }
    return self.clients.openWindow("./");
  })());
});
