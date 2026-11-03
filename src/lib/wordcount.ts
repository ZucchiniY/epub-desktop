/**
 * 统计文本字数：忽略所有空白字符（空格、换行、制表符、全角空格），
 * 其余字符（含中文标点）按字符计数。空文本返回 0。
 */
export function countWords(text: string): number {
  return text.replace(/\s/g, "").length;
}
