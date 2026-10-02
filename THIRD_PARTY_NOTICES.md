# 来源与第三方组件

- 本项目的 Minecraft 地图画机器人流程基于 [aaeddy/wolfxbot](https://github.com/aaeddy/wolfxbot) 的 `painting.js` 扩展和重构。原项目采用 MIT 许可证；本仓库的 `LICENSE` 保留原作者 AEddy & Kyono 的版权声明，并列出本改版的署名。
- 图片切块与调色界面参考 [SlopeCraft](https://github.com/SlopeCraft/SlopeCraft) 及其 imageCutter 的使用流程；地图颜色数值曾对照 SlopeCraft 色表。SlopeCraft 项目采用 GPL-3.0。公开版不附带或运行 SlopeCraft/imageCutter 的程序文件，图片处理与投影生成由本仓库的 JavaScript 代码及 npm 依赖执行。这里的链接是致谢，不表示 SlopeCraft 官方参与、认可或为本项目提供担保。
- `.litematic` 读取、`.schem` 写入和机器人操作使用 `package.json`/`package-lock.json` 中列出的直接或间接 npm 依赖，例如 `prismarine-nbt`、`prismarine-schematic`、Mineflayer 和 Sharp；它们各自适用自己的许可证。仓库不提交 `node_modules/`。如果将来发布捆绑依赖的安装包或 EXE，应另行核对随包分发所需的第三方许可证文本。

本项目的 MIT 声明只适用于我们有权以 MIT 发布的源码。如果今后纳入 SlopeCraft/imageCutter 的 GPL 源码或其直接改写版本，须在发布前重新核对相应的 GPL 义务，不能只加致谢就视为兼容。
