/**
 * 将字节数组解码为字符串。
 *
 * 先尝试 UTF-8 严格解码（非法字节序列会抛错），失败后回退到 GB18030，
 * 从而兼容 GBK/GB2312 编码的中文 TXT 文件。Node 与浏览器的
 * TextDecoder 均支持 "gb18030" 标签。
 */
export function decodeText(bytes: Uint8Array): string {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return new TextDecoder("gb18030").decode(bytes);
  }
}
