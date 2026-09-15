// FR-18.4：分享图的底图。
//
// 六张 CC0 照片，已经按 4:5（1080×1350）裁好、压成 WebP，一共约 1.2MB，
// 随包走 —— 生成分享图这件事必须在离线时也成立。作者与出处在
// `public/share/photos/CREDITS.md`：CC0 不要求署名，但拿了别人的东西总该说得出
// 它是谁的。**换图要同时改三处**，那份清单的末尾写着是哪三处。
//
// 不做「用户自选照片」：那要处理任意尺寸、任意方向、EXIF 旋转、以及一张亮到
// 看不清白字的照片。这是个人自用工具，六张够用。

export interface SharePhoto {
  id: string;
  /** 换图按钮上的名字，也是记录页上那行说明。 */
  label: string;
}

export const SHARE_PHOTOS: SharePhoto[] = [
  { id: 'bergsee-nebel', label: '雾中的山湖' },
  { id: 'winterberge', label: '雪山倒影' },
  { id: 'kreidefelsen', label: '吕根岛白垩崖' },
  { id: 'heide', label: '吕讷堡石南' },
  { id: 'herbstwald', label: '秋天的山毛榉林' },
  { id: 'lindau-nebel', label: '雾中的林道港' },
];

/**
 * 图片地址。走 `BASE_URL` 而不是写死 `/`：原生壳里的 base 由构建决定，
 * 写死斜杠在 WebView 里会指到根目录而不是包里的资源。
 */
export function photoUrl(id: string): string {
  return `${import.meta.env.BASE_URL}share/photos/${id}.webp`;
}

/** 今天默认用哪张 —— 和选句子同一套做法：按日期定，同一天不变。 */
export function photoForDate(dateKey: string, offset = 0): SharePhoto {
  let hash = 0;
  for (const ch of dateKey) hash = (hash * 37 + ch.charCodeAt(0)) % 1_000_003;
  return SHARE_PHOTOS[(hash + offset) % SHARE_PHOTOS.length];
}
