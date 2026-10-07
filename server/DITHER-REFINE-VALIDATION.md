# 照片管线 dither-refine 候选验证（2026-10-07）

状态：代码和自动验证完成，视觉验收尚未全部通过，禁止据此合main或称达到上线质量。等待哈尼独立review；不自动合并。当前origin仓库经GitHub元数据确认是public，用户要求private，推送目标尚待用户确认，没有推送到公开库。

## 范围与真实入口

分支feature/dither-refine，从本地main的d050e33a3f3c6a2d564f14cbb006ac2ef5f6c07c创建独立工作树，原工作区全部未提交成果保留。本轮改动在普通照片模式最长边>52的compact管线。Target、原图还原、<=52的独立小尺寸引擎不改；显式layoutMode:'legacy'保留既有逐格回滚基线。没有更换解码、分割、采样、OKLab、色板、肤色/深色保护或模式路由。

server/src/pattern-core.js为源，运行node scripts/sync-local-pattern-core.mjs同步pages/index/local-pattern-core.js。同步脚本新增最终清理调用，确保再次同步不会丢失本轮行为。cellInfoGrid仅保存为同次生成runtime的临时引用，不加入结果字段或历史数据。实际色号矩阵仍驱动所有用豆统计与本地/服务端输出。

## 实现

1. 最终描边之后执行removeIsolatedColors。命名常量ISOLATED_NEIGHBOR_COLOR_DISTANCE=48，严格小于48视为近色。背景（empty或backgroundCandidate）、detailRgb、skinLike豁免。8邻域只使用真实前景豆色，选择与当前豆色RGB感知距离最近的色号；保持源RGB与透明。固定行优先遍历决定并列，在当前结果上纠正，避免同时交换孤点造成新孤点。完全没有前景邻居时无合法候选，保留原格，不借背景白。
2. getLocalDitherScale保留肤色/深色特例优先。平坦edgeStrength<25且原始格RGB色度<20乘0.5；纹理edgeStrength>90取min(0.6,原值)。现有总强度最高0.52，因此0.6上限通常不触发；原有小格强边缘0.68系数继续保留。没有增加饱和色补偿。

## 自动验证

基线57/57通过；本轮57个既有测试+10个新增测试=67/67通过，0失败、0跳过。完整输出server/review/dither-refine/npm-test.log；本机Node v24.19.0 / macOS arm64，总测试约13.4秒，不是真机耗时。系统无全局npm，使用独立npm CLI执行同一test脚本：

```sh
node /tmp/hani-target-npm/package/bin/npm-cli.js --prefix server test
node /tmp/hani-target-npm/package/bin/npm-cli.js --prefix server run check
node scripts/sync-local-pattern-core.mjs
```

有npm的环境可直接cd server && npm test。syntax/json/WXML检查通过。

新增测试覆盖3x3 H1中央F8纠正为H1、单格瞳孔/肤色/背景豁免、对角邻居、严格48边界、最近邻和确定性、无邻居前景、活跃结果纠正、平坦两阈值、纹理90边界与既有衰减、保护优先级、legacy回滚，以及53x53/64x104/104x104的完整本地/服务端矩阵、尺寸、用豆数和合法色号一致性。没有注掉测试或重写历史golden。

## 真图与统一参数

104x104，board，compact，MARD221，threshold=none。人像使用已有真实照片photo-astronaut.png，动物使用用户已有silver-cat.jpg，物品使用Smithsonian真实红陶瓷杯照片。

物品来源：https://americanhistory.si.edu/collections/object/nmah_1424239
测试图下载：https://ids.si.edu/ids/deliveryService?id=NMAH-AHB2013q040058_v1&max_w=1200
输入只用于内部验证，不当作产品资产。PNG为最终真实豆色渲染，左右为修改前/后。没有按样本身份写生成特例。额外人像近景是原照片x=105,y=5,w=220,h=230的输入裁剪，单独标注，没有冒充新照片或原始整图。

|样本|全图色数 前→后|符合规则的孤点 前→后|全图纹理格色数 前→后|改变格数|
|---|---:|---:|---:|---:|
|人像|77→77|29→0|59→59|522|
|银猫|41→41|5→0|30→29|554|
|红杯|27→27|0→0|17→17|1174|

符合规则的孤点：排除背景/detailRgb/skinLike后，存在前景邻居却没有mardColorDistance<48邻居。三图终态均为0。全图纹理格按edgeStrength>90且非肤色统计，包含耳缘等，并非可靠语义毛发分割。银猫减少的稀有纹理色为G16，不能静默把30→29称为色号不减少。

固定人工ROI（网格0起点、右/下端不含，前后完全同范围）：

|区域|ROI x0,y0,x1,y1|色号种类 前→后|8邻域同色孤点 前→后|
|---|---|---:|---:|
|人像脸部|36,20,55,37|26→25|46→43|
|银猫胸毛|20,61,81,94|18→18|321→263|
|红杯杯体矩形|35,37,66,73|20→20|54→58|

这里“同色孤点”比感知近色孤点更严格，仅作量化噪点代理，不能直接等同杂色或制作质量；杯体ROI也包含部分边界。详见region-metrics.json。

## 调参记录与未通过项

按25/20/90先实现并核对三图。另做两次有界银猫核对：平坦阈值20/20和25/16均未保住全图纹理稀有色，仍29；没有证据支持更换，故保留25/20/90，并把结论写在镜像代码注释。未启动参数搜索或更改保护优先级。

- 红杯周围灰色平坦背景明显减少椒盐状色块，但红杯杯体未证明变干净；不能用背景改善冒充物品主体改善。
- 人像脸部变化很小，同色孤点46→43；近景额外核对也没有明显脸部改善。没有达到“肉眼可见减少”的强验收。
- 银猫胸毛ROI色号18→18，孤点321→263；但全图纹理色号30→29，若按全图纹理定义验收则仍失败。两种口径同时公开，不以选择区域掩盖失败。
- 源detailRgb豁免是“清理不改该格”，并非保证整次生成的瞳孔量化永远同号；上游扩散改变可能使保护格选色发生变化（整个人像/银猫各1个detail格改变）。
- 真机、实际拼豆及十二月六日上线验收均未执行。这是待独立review的候选，不是已批准上线版本。

## 审阅文件

server/review/dither-refine内有三张对比PNG、额外近景PNG、metrics.json、region-metrics.json、tuning.json、完整测试日志。代码增量可用git diff d050e33...feature/dither-refine查看；本地main包含之前Target提交，远端main可能尚未包含它，不要把此前Target改动归为本轮。
