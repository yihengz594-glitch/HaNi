# 小尺寸转换验证（2026-09-30）

## 范围与原因

最终最长边 ≤52 路由到独立 `shared/small-pattern-engine.js`，包含52。>52保留原流程、默认参数和MARD数据。原低格数引擎文件未改。

实际附件1是旧结果截图，附件2才是274×287原图，附件3–9是参考。原图可识别约9.45像素间距的像素网格。旧实现先平滑放大到1200，再缩小；固定颜色数聚类丢失白色中心，将脸和帽子合并；低覆盖率暗色优先和额外描边增加黑色占比。未发现MARD数据或预览色号映射错误。当前原图复跑旧版为681豆，与截图672豆不完全相同，不能证明截图使用了完全相同的原文件/解码状态。

新实现：原尺寸RGBA读取；双轴周期网格识别和格内中位数重建；普通卡通主色/高对比细节采样；照片不套像素网格；LAB距离与白/黑/色相分区保护；不固定总颜色数，不膨胀轮廓。透明与不透明白色分开，棋盘背景不默认当透明。保留用户画布尺寸和比例模式。

## 已验证

- `pnpm check`通过，`pnpm test`29/29通过（server目录）。
- 同原图、MARD221、不合并：29、38、48、52以及38×52。
- 4类输入：粉色原图、项目猫插画、透明PNG测试图、普通照片。
- 28组修改前完整JSON SHA256基准一致：53/64/80、38×53、53×38，另含图片比例和72色/中合并。覆盖尺寸、色号矩阵、空格掩码、源RGB及豆数；色号统计由矩阵派生。
- 20组小尺寸本地/服务端最终结果一致；编辑和导出原有同网格测试通过。
- 38×38本地Canvas基准：白色0→224格，黑色H7占比43.9%→26.8%。最终906豆。微信模拟器实际906豆/白色224格；JPEG解码有少量色号差异（模拟器H7为242，Node为243），不声称跨解码器逐格完全一致。
- 微信工具热编译、选图、38×38生成和用色清单实际成功。真机未验证。
- 本次微信二维码预览实际失败：主包2231KB超过2048KB。没有新二维码、没有上线，也没有为了打包压缩用户原图或改变大尺寸算法。

## 对照文件

`/private/tmp/pinbead-small-preview/index.html` 包含10组同图同参数新旧效果和大尺寸一致状态；`comparison.png` 包含输入、旧38、新38、真实参考截图裁切。新旧效果均无网格，灰色空格/白色拼豆。`report.json`及每个尺寸JSON可复查。普通照片另在photo目录。

自动算法不是人工逐格修整，29格等小尺寸仍受整数采样和真实豆色约束；照片会保留更多色号，不承诺所有题材达到手工参考品质。

## 修改文件

- 新增 shared/small-pattern-engine.js
- server/src/pattern-core.js：仅引擎引用及52边界
- scripts/sync-local-pattern-core.mjs、生成的pages/index/local-pattern-core.js
- server/test/small-pattern-engine.test.js、low-resolution-engine.test.js
- server/scripts/check-syntax.mjs、compare-small-patterns.mjs、snapshot-small-baseline.mjs、preview-small-patterns.mjs
- server/test/fixtures下基准JSON、原图、照片和透明/白色/棋盘测试构造
- 本验证说明

未改生成页面、MARD色板、原大尺寸函数、账本、任务扣次或生产数据库。

## 回退

修改前文件保存在 `/private/tmp/pinbead-small-baseline.nWCm3Q`。临时目录可能被系统清理，请需要长期留存时复制到自选备份位置。

最小运行回退（项目根目录执行，只恢复本次引擎接线，不使用git reset）：

```sh
cp /private/tmp/pinbead-small-baseline.nWCm3Q/server/src/pattern-core.js server/src/pattern-core.js
cp /private/tmp/pinbead-small-baseline.nWCm3Q/scripts/sync-local-pattern-core.mjs scripts/sync-local-pattern-core.mjs
cp /private/tmp/pinbead-small-baseline.nWCm3Q/pages/index/local-pattern-core.js pages/index/local-pattern-core.js
```

新引擎可保留但不再调用。新测试针对新版输出，回退后需恢复旧low-resolution-engine.test.js并停用新版专用测试，不能把预期失败误判为旧引擎故障。
