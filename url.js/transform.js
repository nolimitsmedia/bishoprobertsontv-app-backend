// server-api/utils/transform.js
const { absMediaUrl } = require("./url");

function transformVideoRows(rows) {
  return rows.map((v) => {
    if (v.thumbnail_url) {
      v.thumbnail_url = absMediaUrl(v.thumbnail_url);
    }
    if (v.poster_url) {
      v.poster_url = absMediaUrl(v.poster_url);
    }
    if (v.video_hls_url) {
      v.video_hls_url = absMediaUrl(v.video_hls_url);
    }
    if (v.video_mp4_url) {
      v.video_mp4_url = absMediaUrl(v.video_mp4_url);
    }
    return v;
  });
}

module.exports = { transformVideoRows };
