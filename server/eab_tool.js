/**
 * eab 资源包解密查看工具 (官方格式逆向):
 *   magic 8B: [137,69,65,66,13,10,26,10] (byte6=26 明文 / 27 XXTEA 加密)
 *   加密: XXTEA(data[8..], key=根目录 eab.key.json 的 xxteaKey)
 *   之后: uint32LE 配置长度 + 配置 JSON(UTF8) + 原始资源 blob
 * 解密/解码实现见 decode_config_eab.js (客户端逐行移植, 浏览器实测校准);
 * 本文件只做 CLI: 查看 / 导出子资产。
 * 用法: node eab_tool.js <file.eab> [outdir|dump|info]
 */
const fs = require("fs");
const path = require("path");
const { decodeEab } = require("./decode_config_eab");

// ---- 主流程 ----
const [, , file, outdir] = process.argv;
if (!file) {
  console.error("用法: node eab_tool.js <file.eab> [outdir|dump|info]");
  process.exit(1);
}
const buf = fs.readFileSync(file);
const { config, raw } = decodeEab(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength));

if (!outdir || outdir === "info") {
  console.log("config 顶层键:", Object.keys(config));
  console.log("config:", JSON.stringify(config).slice(0, 3000));
  console.log("raw 大小:", raw.length);
} else if (outdir === "dump") {
  console.log(JSON.stringify(config, null, 2).slice(0, 20000));
} else {
  fs.mkdirSync(outdir, { recursive: true });
  fs.writeFileSync(path.join(outdir, "_config.json"), JSON.stringify(config, null, 1));
  fs.writeFileSync(path.join(outdir, "_raw.bin"), raw);
  console.log("config -> _config.json, raw -> _raw.bin (", raw.length, "bytes )");
  console.log("config 键:", Object.keys(config).join(","));
}
