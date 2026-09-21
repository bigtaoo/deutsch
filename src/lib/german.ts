// 德语字形上的两条等价规则。**两个功能共用**，所以它们住在这里而不是各自的模块里：
//
//   · 听写校验（§7.4）要判「没有德语键盘的人打出来的那种写法」算不算对；
//   · cloze 组题（FR-21.8）要在句子里找出同一个词的屈折形式，
//     而德语的复数/比较级常常带变音（`Vorhang → Vorhänge`、`Buch → Bücher`）——
//     不折叠变音的话，一半的名词在自己的例句里遮不掉，答案就印在题面上。
//
// 两处各自实现一遍的代价不是代码重复，是**两套规则会慢慢长歪**：
// 某天给听写加了 `ae → ä`，而 cloze 那边没加，症状是「某些词的挖空题偶尔泄底」。

/** 去掉变音符：ä→a、ß→ss。大小写原样保留，要不要小写化由调用方决定。 */
export function stripDiacritics(text: string): string {
  return text
    .replace(/ä/g, 'a').replace(/Ä/g, 'A')
    .replace(/ö/g, 'o').replace(/Ö/g, 'O')
    .replace(/ü/g, 'u').replace(/Ü/g, 'U')
    .replace(/ß/g, 'ss');
}
