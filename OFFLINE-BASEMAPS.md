# 全国城市离线底图包（已独立成仓）

中国 370 个城市的离线矢量底图包、切包流水线与城市索引，**已迁出本仓库**，独立维护：

- 仓库：https://github.com/DeveloperYe/china-offline-basemaps
- 索引：	iles/cities-index.json（370 条：adcode / 名称 / bboxPadded / center / bytes / sha256 / 直链）
- 规模：370 个单元、约 11.6 GB，每城一个 Release（标签 `city-<adcode>-<source>`）
- 数据：© OpenStreetMap contributors，ODbL

本仓库只保留**随 APK 内置的默认城市包**（`src/static/tiles/qingdao-all.pmtiles`，青岛），
它由 CI 在构建时按固定 sha256 从 Release `tiles-qingdao-all-5` 拉取
（见 `.github/workflows/build-android.yml` 的 Fetch offline tile pack 步骤）。

App 端「城市切换」功能还没开发：届时从上面那个仓库拉索引、下载包到本地用户目录、
校验 sha256 后交给 map-view 建图。
