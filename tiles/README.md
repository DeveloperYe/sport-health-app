# 城市离线底图索引

## cities.json

370 个行政区单元（333 个地级市 + 4 个直辖市 + 港澳 + 省直辖县级单位），字段：

| 字段 | 说明 |
|---|---|
| `adcode` | 国家统计局行政区划代码（6 位），同时用作瓦片包文件名 |
| `name` | 城市名 |
| `province` | 所属省级单位名 |
| `kind` | `city` / `municipality` / `sar` / `province` |
| `bbox` | `[west, south, east, north]`，行政区边界的外接矩形 |
| `bboxPadded` | bbox 四周各外扩 0.02°（跑步常在边界活动，留出余量）——**切包用这个** |
| `center` | `[lng, lat]`，地图初始中心 |
| `tilesZ15` | 该 bbox 在 z15 覆盖的瓦片数（用于估算包体，是上界不是实测） |

`provinces.json` 是同源的省级清单，供"按省批量切/下载"使用。

数据来源：阿里 DataV 行政区边界（`geo.datav.aliyun.com/areas_v3`）。重新生成：

```
node tmp-tools/gen-city-list.mjs   # 脚本见会话工作区，逻辑：逐省取 {adcode}_full.json 求 bbox
```

## 瓦片包命名与下载

批量切包见 `.github/workflows/build-city-tiles.yml`。每个城市一个 Release：

```
tag:   city-<adcode>-<source>            例：city-370200-20261029
asset: <adcode>.pmtiles                  例：370200.pmtiles
直链:  https://github.com/DeveloperYe/sport-health-app/releases/download/city-<adcode>-<source>/<adcode>.pmtiles
```

固定标签 + 固定资产名 => 地址稳定，重跑同源日期即覆盖同名资产。

## App 端消费方式（待开发的城市切换功能）

1. 读 `cities.json`（可随 App 内置，也可远端拉取）
2. 按 adcode 拼出下载直链，下载到本地用户目录（不是 `static/`，APK 内只保留默认城市）
3. 校验字节数与 sha256（Release 描述与索引里都有）
4. 把文件路径交给 `map-view` 直接建图；切换城市 = 换档案 + 换 `center`/`bounds`

> 注意：APK 内置的 `src/static/tiles/qingdao-all.pmtiles` 是默认城市（青岛），
> 其余城市走下载。切包源一旦过期（Protomaps 日构建只留约 5 天）无法重切，
> 已切好的包要长期保留在 Release 上。

## cities-index.json（成品索引，App 直接用这个）

由 `gen-city-index.mjs` 从 Releases API 汇总生成：每个城市的包已切好并挂到 Release，
资产自带 `size` 与 `digest(sha256)`，无需下载回来算哈希。

| 字段 | 说明 |
|---|---|
| `file` | 资产文件名，即 `<adcode>.pmtiles` |
| `bytes` | 资产字节数（下载后必须校验） |
| `sha256` | 资产摘要（下载后必须校验） |
| `url` | 下载直链 `https://github.com/<repo>/releases/download/city-<adcode>-<source>/<adcode>.pmtiles` |
| `ready` | 该城市包是否已发布 |

顶层还有 `source`（切包所用 Protomaps 日期）、`ready`、`totalBytes`。

**当前状态（2026-10-30，source=20261029）**：370/370 就绪，合计 11.59 GB。
抽检 4 个（北京 93.84MB / 三沙 78.25MB / 成都 52.16MB / 澳门 4.63MB）：
大小与 sha256 全部一致，`pmtiles show` 的 bounds 与索引 `bboxPadded` 逐项吻合。

### 已知边界

- **三沙市**包 78MB 但覆盖的是南海大片海域（150 万瓦片），实际跑步用不到，可按需不下载。
- 城市包是**按行政区外接矩形**切的，相邻城市会有少量重叠（各自独立，互不影响）。
- 切包源为 Protomaps 日构建，**只保留约 5 天**：已切好的包必须长期留在 Release，
  过期后无法按同一天重切（但可用新日期切出等价包）。
