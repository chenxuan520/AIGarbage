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
  "内容仍要基于事实展开,不要胡编数据。" +
  "【重要】不要堆砌乱七八糟、无意义的 emoji 或表情符号——标题、小标题、正文都不要用 emoji 凑气氛,靠文字本身的张力。" +
  "直接返回 markdown 正文,不要任何额外说明或前后缀。";

/** Topic-selection agent: pick one topic and return strict JSON. */
export function buildSelectMessages(
  candidates: NewsItem[],
  recentTitles: string[] = [],
): ChatMessage[] {
  const list = candidates.map((c, i) => `${i + 1}. ${c.title}`).join("\n");
  const avoidBlock = recentTitles.length
    ? "最近一个月已经写过的选题(下面这些主题、以及与它们高度相似的同一事件,都【绝对禁止】再选," +
      "必须另挑一个全新、不重复的选题):\n" +
      recentTitles
        .slice(0, 50)
        .map((t) => `- ${t}`)
        .join("\n") +
      "\n\n"
    : "";
  return [
    {
      role: "system",
      content:
        "你是一个爆款自媒体的选题编辑。从给定热点标题里挑 1 个最有“爆点”、" +
        "最适合写成 UC 标题党爆款文的选题,并给出抓人的写作角度、几个要点,以及一句英文配图描述。" +
        "重要:绝不能选最近已经写过或高度相似的选题,务必保证选题新鲜、不与近期重复。",
    },
    {
      role: "user",
      content:
        `候选热点标题:\n${list}\n\n` +
        avoidBlock +
        "只输出一个 JSON 对象,不要包含 markdown 代码块、注释或任何额外文字。" +
        "chosenTitle 对应的选题不能与上面“已经写过”的任何一条重复或高度相似。" +
        "imagePrompts 必须是 5 条不同的英文配图描述,每条描述一个明确的真实场景或主体" +
        "(人物、地点、物件、自然或工业场景等),写实纪实摄影风格、专业、构图干净、贴合主题。" +
        "为避免画面出现乱码文字,务必避开任何天然带文字的元素:不要出现招牌/广告牌/报纸/杂志/书页/" +
        "电脑或手机屏幕界面/海报/横幅/品牌 logo/车牌/字幕等;改用人物表情、动作、环境、物体等无文字的画面。" +
        "另外【不要】在描述里写 “no text”“without words” 这类否定词——绘图模型不认这种否定,反而更容易画出乱码字。\n" +
        "严格使用如下结构:\n" +
        `{"chosenTitle":"一个夸张吸睛、带悬念或反问的标题党标题",` +
        `"angle":"一句话点出爆点/冲突/反差",` +
        `"keyPoints":["要点1","要点2","要点3"],` +
        `"imagePrompts":["a realistic candid photo of people in a relevant real-world scene","a documentary close-up of a related object or detail","a wide environmental shot of the location at golden hour","a photorealistic portrait of a person involved","an aerial photo of a related site"]}`,
    },
  ];
}

/** Trim reference material so it grounds the model without blowing the budget. */
function refBlock(reference: string, max = 3500): string {
  const r = (reference || "").trim();
  if (!r) return "";
  return (
    "【原文资料 / 事实依据(务必基于以下真实内容写作,关键事实、人物、数字、时间以原文为准," +
    "绝不能编造与原文矛盾或原文没有的事实;可在事实基础上做分析与展开)】:\n" +
    r.slice(0, max) +
    "\n\n"
  );
}

const FACT_RULE_REF =
  "- 内容必须严格基于上面的原文资料,关键事实/数字/人物/时间以原文为准,绝不凭空捏造;原文没提到的具体事实不要编造,可以做合理分析和延展。\n";
const FACT_RULE_NOREF = "- 内容基于事实,不要编造具体数字;可以渲染情绪但别造假。\n";
const NO_EMOJI = "- 不要使用任何 emoji 或表情符号(标题和正文都不要)。\n";

/** Writing agent: the OPENING (hook + background + cause). Stops before the
 *  middle character-story, which is generated separately and spliced in. */
export function buildWriteMessages(sel: TopicSelection, reference = ""): ChatMessage[] {
  const points = (sel.keyPoints ?? []).map((p) => `- ${p}`).join("\n");
  const ref = refBlock(reference);
  return [
    { role: "system", content: WRITER_STYLE },
    {
      role: "user",
      content:
        "请写一篇 UC 标题党风格中文爆款文章的【开头部分】(引子 + 背景 + 起因/矛盾)。" +
        "这只是文章前半,后面会再补一段人物故事和结尾,所以现在【不要】写结尾、不要做总结。\n" +
        `参考标题: ${sel.chosenTitle}\n` +
        (sel.angle ? `爆点/角度: ${sel.angle}\n` : "") +
        (points ? `要覆盖的要点:\n${points}\n` : "") +
        "\n" +
        ref +
        "要求:\n" +
        "- 第一行必须是一级标题(# 标题),标题党:夸张吸睛、带悬念或反问、可用数字和感叹号,但别离题。\n" +
        "- 开头第一段用一个强钩子(设问/反差/悬念)把读者勾住。\n" +
        "- 用 2-3 个二级小标题(## )交代背景和起因/矛盾,短段落、短句、口语化。\n" +
        (ref ? FACT_RULE_REF : FACT_RULE_NOREF) +
        NO_EMOJI +
        "- 篇幅 1200-1600 字,写到'矛盾/悬念'就停,留白给后面的人物故事,先别收尾、别下结论。\n" +
        "- 只输出 markdown 正文,不要任何额外说明。",
    },
  ];
}

/** Writing agent: the MIDDLE character story (~1500字) — the engagement core.
 *  Uses an UN-verifiable, representative/pseudonymous character on purpose. */
export function buildStoryMessages(sel: TopicSelection, reference = ""): ChatMessage[] {
  const ref = refBlock(reference, 2000);
  return [
    { role: "system", content: WRITER_STYLE },
    {
      role: "user",
      content:
        `为这篇关于「${sel.chosenTitle}」的爆款文章写一段【人物故事】,放在文章正中间。` +
        "目的只有一个:把这个抽象议题写成一个具体的人的命运,让读者狠狠代入、看得揪心。\n" +
        ref +
        "硬性要求:\n" +
        "- 1400-1600 字,强叙事:具体的人、具体的场景细节、对话、心理活动、情绪起伏,并有一个转折或高潮。\n" +
        "- 主角用一个【不可考证的代表性/化名人物】(例如“我们姑且叫他老陈”“32 岁的工程师小林”)," +
        "可以虚构他的经历来折射真实现象;但【不要】把虚构台词/情节安到真实公众人物、真实公司高管头上,不要编可被查证的真名实姓。\n" +
        (ref ? "- 背景设定要贴合上面的原文事实(行业、时间、大势),人物是典型化身。\n" : "") +
        "- 用 1-2 个二级小标题组织(如 ## 一个人的三年 / ## 老陈的选择);第一行【不要】写一级标题(#)。\n" +
        "- 口语化、有画面感、能戳情绪,紧扣选题,别空喊口号。\n" +
        NO_EMOJI +
        "- 只输出这段故事的 markdown 正文片段,不要任何说明。",
    },
  ];
}

/** Writing agent: the CLOSING (impact + analysis + a punchy ending). Once. */
export function buildClosingMessages(sel: TopicSelection, reference = ""): ChatMessage[] {
  const ref = refBlock(reference, 1500);
  return [
    { role: "system", content: WRITER_STYLE },
    {
      role: "user",
      content:
        `为这篇关于「${sel.chosenTitle}」的爆款文章写【结尾部分】:影响 + 各方/行业现状 + 一个有力的收尾。\n` +
        ref +
        "要求:\n" +
        "- 用 2-3 个二级小标题(## )讲清楚:影响有多大、各方/行业怎么看、对普通人意味着什么,最后一段简短有力地收尾(可留个钩子或反问)。\n" +
        "- 不要重复前文已经说过的内容,不要车轱辘话,不要“综上所述/总而言之”这种套话凑字。\n" +
        (ref ? "- 忠于上面的原文事实,不得编造与之矛盾的数据。\n" : "") +
        NO_EMOJI +
        "- 篇幅 900-1300 字;第一行【不要】写一级标题(#)。只输出 markdown 正文片段。",
    },
  ];
}

/** Writing agent: a single clean extension when the draft is slightly short.
 *  Deliberately NO fixed "angle list" (that caused the repetitive filler). */
export function buildContinuationMessages(
  sel: TopicSelection,
  tail: string,
  reference = "",
): ChatMessage[] {
  const ref = refBlock(reference, 1500);
  return [
    { role: "system", content: WRITER_STYLE },
    {
      role: "user",
      content:
        `这篇关于「${sel.chosenTitle}」的文章还差一点篇幅,请自然地再补充【一个】还没展开过的具体方面。\n` +
        ref +
        "下面是已写好的结尾片段(仅供衔接,绝对不要重复其中任何内容):\n" +
        `“……${tail}”\n\n` +
        "只写【1 个】二级小标题(## )的小节,聚焦一个具体的新细节、某一方的具体反应、或对某类人的具体影响。\n" +
        "严禁重复前文已有的小标题或观点;严禁编造可被查证的假数据/假机构/假事件;不要写“综上/总之”式套话;不要 emoji。\n" +
        (ref ? "忠于上面的原文事实。\n" : "") +
        "第一行不要写一级标题(#)。只输出这一小节,300-600 字即可,不要任何说明。",
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
