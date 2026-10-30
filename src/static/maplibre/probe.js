// worker 可用性探针（同源静态文件）。
// 主线程 new Worker('static/maplibre/probe.js') 后，本文件回一句话即证明：
//   1) 该源允许创建 worker（origin/CSP 放行）；
//   2) 该目录的文件确实可被 worker 加载。
// 用途见 map-core.prepareWorker()：它比 fetch 探活更贴近真实条件
// （worker 加载不走 CORS 预检，而带自定义头的 fetch 会）。
self.postMessage('ok')
