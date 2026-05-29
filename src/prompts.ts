import type { NewsItem, TopicSelection } from "./types";

export interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

// UC 浏览器 / 今日头条 式自媒体"标题党"爆款小编风格。
export const WRITER_STYLE =
  "你是一个 UC 浏览器、今日头条式的自媒体爆款小编,最擅长写吸睛的“标题党”文章。" +
  "你的风格:标题极度吸睛、爱用悬念和反问;开头一句话就把人勾住;正文口语化、" +
  "短句短段、节奏快,爱用“震惊”“万万没想到”“真相”“背后”“出手了”这类词制造情绪和爽点;" +
  "内容仍要基于事实展开,不要胡编数据。直接返回 markdown 正文,不要任何额外说明或前后缀。";

/** Topic-selection agent: pick one topic and return strict JSON. */
export function buildSelectMessages(candidates: NewsItem[]): ChatMessage[] {
  const list = candidates.map((c, i) => `${i + 1}. ${c.title}`).join("\n");
  return [
    {
      role: "system",
      content:
        "你是一个爆款自媒体的选题编辑。从给定热点标题里挑 1 个最有“爆点”、" +
        "最适合写成 UC 标题党爆款文的选题,并给出抓人的写作角度、几个要点,以及一句英文配图描述。",
    },
    {
      role: "user",
      content:
        `候选热点标题:\n${list}\n\n` +
        "只输出一个 JSON 对象,不要包含 markdown 代码块、注释或任何额外文字。" +
        "imagePrompts 必须是 5 条不同的英文配图描述,每条都要极度夸张、戏剧化、吸睛" +
        "(tabloid / clickbait 风格:夸张的表情或场面、强烈对比、电影级打光),画面里不要出现任何文字。\n" +
        "严格使用如下结构:\n" +
        `{"chosenTitle":"一个夸张吸睛、带悬念或反问的标题党标题",` +
        `"angle":"一句话点出爆点/冲突/反差",` +
        `"keyPoints":["要点1","要点2","要点3"],` +
        `"imagePrompts":["dramatic ENGLISH prompt 1","dramatic ENGLISH prompt 2","dramatic ENGLISH prompt 3","dramatic ENGLISH prompt 4","dramatic ENGLISH prompt 5"]}`,
    },
  ];
}

/** Writing agent: turn the selected topic into a full markdown article. */
export function buildWriteMessages(sel: TopicSelection): ChatMessage[] {
  const points = (sel.keyPoints ?? []).map((p) => `- ${p}`).join("\n");
  return [
    { role: "system", content: WRITER_STYLE },
    {
      role: "user",
      content:
        "请就以下选题写一篇 UC 标题党风格的中文爆款文章:\n" +
        `参考标题: ${sel.chosenTitle}\n` +
        (sel.angle ? `爆点/角度: ${sel.angle}\n` : "") +
        (points ? `要覆盖的要点:\n${points}\n` : "") +
        "\n要求:\n" +
        "- 第一行必须是一级标题(# 标题),标题要标题党:夸张吸睛、带悬念或反问、可用数字和感叹号,但别离题。\n" +
        "- 开头第一段用一个强钩子(设问/反差/悬念)把读者勾住。\n" +
        "- 多用二级小标题(可带【】或表情符号),短段落、短句、口语化,适当用反问和感叹制造代入感。\n" +
        "- 内容基于事实,不要编造具体数字;可以渲染情绪但别造假。\n" +
        "- 尽量写长,至少 2000 字,用尽量多的二级小标题(## )分节充分展开(背景、起因、细节、各方反应、影响、分析等),绝不写空话凑字数;先别急着收尾,后面可能还要继续展开。\n" +
        "- 只输出 markdown 正文,不要输出任何额外说明文字。",
    },
  ];
}

/** Writing agent: continue an existing article with brand-new sections. */
export function buildContinuationMessages(sel: TopicSelection, tail: string): ChatMessage[] {
  return [
    { role: "system", content: WRITER_STYLE },
    {
      role: "user",
      content:
        `你正在续写一篇关于「${sel.chosenTitle}」的 UC 标题党爆款长文。\n` +
        "下面是文章已写好的结尾片段(仅供衔接,绝对不要重复它的内容):\n" +
        `“……${tail}”\n\n` +
        "请紧接着继续往下写,新增 2-3 个**全新角度**的二级小标题(## )小节,延续同样的爆款口语风格。" +
        "从这些还没写过的角度里挑没用过的展开:真实案例 / 具体套路拆解 / 数据与行业现状 / 各方与网友吵翻了 / 法律与维权 / 普通人如何自保 / 背后深层原因 / 未来会怎样 / 一个反转。\n" +
        "每个小节都要有新信息,不要重复前文任何句子,不要写大标题(#),不要写“综上/以上/总之”这种收尾。\n" +
        "直接输出 markdown 正文片段,至少 1200 字,不要任何说明。",
    },
  ];
}

/** Review/harness agent: audit a draft and return a strict JSON verdict. */
export function buildReviewMessages(markdown: string, minChars: number): ChatMessage[] {
  return [
    {
      role: "system",
      content: "你是一个非常严格的爆款文主编,只负责审稿、挑毛病,绝不替作者写文章。",
    },
    {
      role: "user",
      content:
        "审查下面这篇文章,只输出一个 JSON,不要任何额外文字:\n" +
        `{"pass":true或false,"wordCount":中文字数估计(整数),"problems":["问题1","问题2"],"suggestion":"一句话说明该如何改进或扩写"}\n` +
        `判定标准:1) 中文正文字数必须不少于 ${minChars} 字,不足直接 pass=false;` +
        "2) 必须是 UC 标题党/爆款风格(有钩子、有情绪、口语化、标题吸睛);" +
        "3) 结构完整、有多个二级小标题、不烂尾、不空话凑字、不大段重复。\n\n" +
        "文章如下:\n" +
        markdown,
    },
  ];
}

/** Writing agent: rewrite to fix the reviewer's problems while staying long. */
export function buildReviseMessages(
  sel: TopicSelection,
  draft: string,
  problems: string[],
  suggestion: string,
  minChars: number,
): ChatMessage[] {
  const probs = problems.map((p) => `- ${p}`).join("\n");
  return [
    { role: "system", content: WRITER_STYLE },
    {
      role: "user",
      content:
        `请把下面这篇关于「${sel.chosenTitle}」的文章改写得更好。\n` +
        (probs ? `主编指出的问题:\n${probs}\n` : "") +
        (suggestion ? `改进建议:${suggestion}\n` : "") +
        "\n硬性要求:\n" +
        `- 中文正文必须仍然不少于 ${minChars} 字,只能更长、不能变短。\n` +
        "- 保持 UC 标题党/爆款风格:第一行是 # 标题(可改得更吸睛),开头有强钩子,多个二级小标题、短段落、反问感叹。\n" +
        "- 修复上述问题,内容更充实,不要空话凑字。\n" +
        "- 只输出完整 markdown 正文,不要任何说明。\n\n" +
        "原文如下:\n" +
        draft,
    },
  ];
}
