# 全尺寸紧凑排版 · 2026-10-02

## 授权与范围

用户明确要求“全部算法都更改，尽量减少四周空间”。本次将紧凑排版应用于全部格数，包括53以上；这取代此前只改≤52格的排版限制。颜色采样、MARD数据、背景分离、五官增强、编辑/导出和次数账本不重写。

## 实现

- ≤52格去掉人为一格留白。照片分支仅裁掉可确认的纯白外边框，不删除内部白色；真实透明边界按原掩码取完整包围框。
- 大尺寸默认取消3.5%的额外包围框边距和56/1200的画布边距，仅保留约2个分析像素以保护抗锯齿。基于已有背景分离结果，不重做背景识别。
- 保持居中，以contain方式完整适配画板，不用cover裁切、不拉伸、不增加所选格数。长方形画板补偿方形中间Canvas的采样比例；图片比例模式先确定尺寸，再按最终画格比例适配。
- 原大尺寸排版通过内部 `layoutMode:'legacy'` 保留，可用于对照；现有小程序入口默认compact，本地与服务端同步。不新增扣次和制图任务。

## 验证

- `pnpm check`、`pnpm test`32/32通过。
- 14种画板：29/38/48/52/53/64/80/128/160，及38×52、38×53、53×38、64×80、80×64。透明测试主体至少铺满一个方向96%，保持1:2比例、居中及白色主体，真实比例留白不被补色。
- 新旧大尺寸结果不再要求逐格相同，因为放大改变采样位置。原28组完整JSON基准仍在legacy排版下通过，用于验证原链路可回退；另验证新compact本地/服务端一致，图片比例模式接近铺满两轴。
- 原细嘴线、像素角色、透明孔洞、白色衣服、连续头发、编辑撤销/保存、同网格统计/导出测试均通过。
- 同一毕业女孩、MARD221、不合并：52格主体包围框36×50→38×52；64格42×57→46×64；80格52×72→58×80。这里指非空主体包围框，不是整块矩形全部填豆。
- 必要留白仍存在：窄人物放在宽画板，无法同时“不变形、不裁切、填满四边”。普通照片无法确认背景时也不会擅自扣掉场景。

## 对照及未完成项

`/private/tmp/pinbead-compact-preview/index.html`、`comparison-64.png`、`occupancy.json`和各尺寸色号矩阵保存本次同图对照。图片由最终色号网格直接绘制。

```sh
node server/scripts/compare-compact-layout.mjs /private/tmp/pinbead-tight-layout.kMne0z INPUT_IMAGE /private/tmp/pinbead-compact-preview
```

未同步/部署独立网页项目，未上传微信或真机验证，不能称已上线。已有结果不会被自动重新生成；需重新生成才能应用新排版，正式计费环境的生成次数规则保持原样。

## 修改文件与回退

shared/small-pattern-engine.js、server/src/pattern-core.js、scripts/sync-local-pattern-core.mjs及生成的pages/index/local-pattern-core.js；新增compact-layout.test.js和compare-compact-layout.mjs；更新small-pattern-engine.test.js、low-resolution-engine.test.js、pattern-coverage.test.js、compare-small-patterns.mjs、compare-facial-details.mjs、check-syntax.mjs。

改前备份：`/private/tmp/pinbead-tight-layout.kMne0z`。恢复该目录的shared/small-pattern-engine.js、server/src/pattern-core.js、pages/index/local-pattern-core.js，并从目录根恢复sync-local-pattern-core.mjs到scripts/。测试文件备份在目录根，按文件名恢复；新版compact专用测试需与回退版本同步停用或调整。临时目录可能被系统清理，长期留存请另行保存。
