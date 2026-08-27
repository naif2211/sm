const BASE = "https://3asq.online";

function abs(url) {
  if (!url) return undefined;
  try {
    const u = new URL(String(url).trim(), BASE);
    return /^https?:$/i.test(u.protocol) ? u.href : undefined;
  } catch {
    return undefined;
  }
}

function pathFromUrl(url) {
  if (!url) return "";
  try {
    const u = new URL(String(url).trim(), BASE);
    if (!/^https?:$/i.test(u.protocol)) return "";
    return u.pathname.replace(/^\/+|\/+$/g, "") + (u.search || "");
  } catch {
    return "";
  }
}

async function getDoc(path) {
  const res = await harbor.http(BASE + path, { responseType: "text" });
  if (!res.ok) return null;
  return harbor.parseHtml(res.body);
}

function firstText(root, selectors) {
  for (const selector of selectors) {
    const el = root.querySelector(selector);
    const value = el ? (el.text() || "").trim() : "";
    if (value) return value;
  }
  return "";
}

function metaValue(doc, names) {
  const wanted = names.map((x) => x.toLowerCase());
  for (const meta of doc.querySelectorAll("meta")) {
    const key = ((meta.attr("property") || meta.attr("name") || "") + "").toLowerCase();
    if (wanted.includes(key)) return (meta.attr("content") || "").trim();
  }
  return "";
}

function imageUrl(img) {
  if (!img) return undefined;
  return abs(
    img.attr("data-src") ||
      img.attr("data-lazy-src") ||
      img.attr("data-original") ||
      img.attr("data-lazy") ||
      img.attr("src")
  );
}

function getCover(doc) {
  const metaCover = metaValue(doc, ["og:image", "twitter:image"]);
  if (metaCover) return abs(metaCover);

  for (const selector of [
    ".summary_image img",
    ".summary-image img",
    ".post-thumbnail img",
  ]) {
    const url = imageUrl(doc.querySelector(selector));
    if (url) return url;
  }

  return undefined;
}

function isMangaLink(href) {
  return !!href && /\/manga\//i.test(href) && !/\/manga\/[^/]+\/\d+(?:\.\d+)?\/?(?:\?.*)?$/i.test(href);
}

function isChapterLink(href) {
  return !!href && (
    /\/manga\/[^/]+\/\d+(?:\.\d+)?\/?(?:\?.*)?$/i.test(href) ||
    /chapter[\s._-]*\d+(?:\.\d+)?/i.test(href)
  );
}

function parseChapterNumber(text, href) {
  const source = `${text || ""} ${href || ""}`;

  const patterns = [
    /chapter[\s._-]*(\d+(?:\.\d+)?)/i,
    /\bch[\s._-]*(\d+(?:\.\d+)?)/i,
    /\/([0-9]+(?:\.[0-9]+)?)\/?(?:\?.*)?$/,
  ];

  for (const re of patterns) {
    const m = source.match(re);
    if (m) return m[1];
  }

  return null;
}

function getChapterBase(mangaId, doc) {
  const candidates = [];

  for (const selector of [
    ".wp-manga-chapter a",
    ".wp-manga-chapters a",
    ".chapter-list a",
    ".version-chap a",
    ".listing-chapters_wrap a",
    ".chapter-item a",
    'a[href*="/manga/"]',
  ]) {
    for (const a of doc.querySelectorAll(selector)) {
      const href = a.attr("href") || "";
      const n = parseChapterNumber(a.text(), href);
      if (!n || !isChapterLink(href)) continue;
      const p = pathFromUrl(href).replace(/[?].*$/, "");
      if (!p) continue;
      const base = p.replace(/\/\d+(?:\.\d+)?\/?$/i, "");
      if (base) candidates.push(base);
    }
  }

  if (candidates.length) return candidates[0];

  return String(mangaId || "")
    .replace(/^\/+|\/+$/g, "")
    .replace(/\/\d+(?:\.\d+)?\/?$/i, "");
}

function findChapterBounds(doc) {
  let min = null;
  let max = null;
  let decimalNumbers = new Set();

  for (const a of doc.querySelectorAll('a[href*="/manga/"]')) {
    const href = a.attr("href") || "";
    const n = parseChapterNumber(a.text(), href);
    if (!n || !isChapterLink(href)) continue;

    const value = Number(n);
    if (!Number.isFinite(value)) continue;

    if (min === null || value < min) min = value;
    if (max === null || value > max) max = value;
    if (!Number.isInteger(value)) decimalNumbers.add(value);
  }

  return { min, max, decimals: Array.from(decimalNumbers).sort((a, b) => a - b) };
}

function buildNumberedChapters(basePath, min, max, decimals) {
  if (min === null || max === null || !basePath) return [];

  const out = [];
  const seen = new Set();

  // Generate every integer between the first and latest chapter.
  const start = Math.max(0, Math.floor(min));
  const end = Math.floor(max);

  for (let n = start; n <= end; n++) {
    const number = String(n);
    const id = `${basePath}/${number}`;

    if (seen.has(id)) continue;
    seen.add(id);

    out.push({
      id,
      chapter: number,
      title: `الفصل ${number}`,
      volume: null,
      pages: 0,
      // Harbor filters chapters by language. The 3asq source is Arabic,
      // but "en" is used here for compatibility with Harbor installations
      // that only request the English chapter bucket.
      language: "en",
    });
  }

  // Preserve decimal chapters such as 885.5.
  for (const n of decimals || []) {
    const number = String(n);
    const id = `${basePath}/${number}`;
    if (seen.has(id)) continue;

    seen.add(id);
    out.push({
      id,
      chapter: number,
      title: `الفصل ${number}`,
      volume: null,
      pages: 0,
      language: "en",
    });
  }

  out.sort((a, b) => parseFloat(b.chapter) - parseFloat(a.chapter));
  return out;
}

function parseVisibleChapters(doc) {
  const out = [];
  const seen = new Set();

  for (const selector of [
    ".wp-manga-chapter a",
    ".wp-manga-chapters a",
    ".chapter-list a",
    ".version-chap a",
    ".listing-chapters_wrap a",
    ".chapter-item a",
    'a[href*="/manga/"]',
  ]) {
    for (const a of doc.querySelectorAll(selector)) {
      const href = a.attr("href") || "";
      if (!isChapterLink(href)) continue;

      const number = parseChapterNumber(a.text(), href);
      const id = pathFromUrl(href);
      if (!number || !id || seen.has(id)) continue;

      seen.add(id);
      out.push({
        id,
        chapter: number,
        title: (a.text() || a.attr("title") || `الفصل ${number}`).trim(),
        volume: a.attr("data-volume") || a.attr("data-vol") || null,
        pages: 0,
        language: "en",
      });
    }
  }

  out.sort((a, b) => parseFloat(b.chapter) - parseFloat(a.chapter));
  return out;
}

function summaries(doc) {
  const out = [];
  const seen = new Set();

  for (const selector of [
    ".page-item-detail",
    ".bsx",
    ".manga-item",
    "article",
  ]) {
    for (const card of doc.querySelectorAll(selector)) {
      let link = null;

      for (const a of card.querySelectorAll("a")) {
        const href = a.attr("href") || "";
        if (isMangaLink(href)) {
          link = a;
          break;
        }
      }

      if (!link) continue;

      const id = pathFromUrl(link.attr("href") || "");
      const title = (
        link.attr("title") ||
        link.text() ||
        firstText(card, ["h2", "h3", ".title"]) ||
        ""
      ).trim();

      if (!id || !title || seen.has(id)) continue;
      seen.add(id);
      out.push({
        id,
        title,
        cover: imageUrl(card.querySelector("img") || link.querySelector("img")),
      });
    }
  }

  return out;
}

function listingPaths(kind, page, query, tagId) {
  const q = encodeURIComponent(query || "");
  const t = tagId ? encodeURIComponent(tagId) : "";

  if (kind === "popular") {
    if (tagId) {
      return [
        `/manga-genre/${t}/?m_orderby=views&page=${page}`,
        `/genre/${t}/?m_orderby=views&page=${page}`,
      ];
    }

    return [
      `/manga/?m_orderby=views&page=${page}`,
      `/manga/page/${page}/?m_orderby=views`,
    ];
  }

  if (tagId) {
    return [
      `/manga-genre/${t}/?s=${q}&post_type=wp-manga&page=${page}`,
      `/genre/${t}/?s=${q}&post_type=wp-manga&page=${page}`,
    ];
  }

  return [
    `/manga/?s=${q}&post_type=wp-manga&page=${page}`,
    `/?s=${q}&post_type=wp-manga&page=${page}`,
  ];
}

async function fetchListing(paths) {
  for (const p of paths) {
    const d = await getDoc(p);
    if (!d) continue;
    const items = summaries(d);
    if (items.length) return items;
  }

  return [];
}

async function pageUrls(id) {
  const p = String(id).replace(/^\/+/, "");
  const d = await getDoc("/" + p);
  if (!d) return [];

  const out = [];
  const seen = new Set();

  for (const selector of [
    ".reading-content img",
    "#readerarea img",
    ".page-break img",
    ".entry-content .page-break img",
    ".wp-manga-chapter-img img",
    ".manga-chapter img",
  ]) {
    for (const image of d.querySelectorAll(selector)) {
      const url = imageUrl(image);
      if (!url || seen.has(url)) continue;
      seen.add(url);
      out.push(url);
    }
  }

  return out;
}

const plugin = {
  id: "3asq-online",
  name: "3asq.online",

  async popular(offset, tagId) {
    const page = Math.floor(offset / 48) + 1;
    return await fetchListing(listingPaths("popular", page, "", tagId));
  },

  async search(query, offset, tagId) {
    const page = Math.floor(offset / 48) + 1;
    return await fetchListing(listingPaths("search", page, query, tagId));
  },

  async detail(id) {
    const cleanId = String(id).replace(/^\/+/, "");
    const d = await getDoc("/" + cleanId);
    if (!d) return null;

    const visible = parseVisibleChapters(d);
    const bounds = findChapterBounds(d);

    return {
      id,
      title:
        firstText(d, [".post-title h1", ".summary-title h1", "h1.entry-title", "h1"]) ||
        metaValue(d, ["og:title", "twitter:title"]) ||
        id,
      altTitle: firstText(d, [".alternative", ".alt-title"]) || undefined,
      cover: getCover(d),
      year: (() => {
        const m = firstText(d, [".year", ".release-year", ".summary-content.year"]).match(/\b(19\d{2}|20\d{2})\b/);
        return m ? Number(m[1]) : undefined;
      })(),
      status: firstText(d, [".post-status .summary-content", ".summary-content.status"]) || undefined,
      description:
        metaValue(d, ["og:description", "description"]) ||
        firstText(d, [".summary__content", ".summary_content", ".summary-content", ".description-summary"]),
      lastChapter: visible.length ? visible[0].title : undefined,
      author: firstText(d, [".author-content", ".author", ".summary-content.author"]) || undefined,
      chapterCount: bounds.min !== null && bounds.max !== null
        ? Math.floor(bounds.max) - Math.ceil(bounds.min) + 1
        : undefined,
    };
  },

  async chapters(id) {
    const cleanId = String(id).replace(/^\/+/, "");
    const d = await getDoc("/" + cleanId);
    if (!d) return [];

    const bounds = findChapterBounds(d);
    const basePath = getChapterBase(cleanId, d);

    // The manga page exposes only the first/latest chapter links in its HTML.
    // Build all numbered chapter IDs between those bounds so Harbor can show
    // the complete sequence without depending on the hidden AJAX chapter list.
    const generated = buildNumberedChapters(
      basePath,
      bounds.min,
      bounds.max,
      bounds.decimals
    );

    // Keep any visible non-standard chapter links too.
    const visible = parseVisibleChapters(d);
    const byId = new Map();

    for (const item of generated) byId.set(item.id, item);
    for (const item of visible) byId.set(item.id, item);

    const result = Array.from(byId.values());
    result.sort((a, b) => parseFloat(b.chapter) - parseFloat(a.chapter));
    return result;
  },

  async pageUrls(id) {
    return await pageUrls(id);
  },

  async tags() {
    const out = [];
    const seen = new Set();

    for (const p of ["/manga-genre/", "/genre/", "/genres/", "/"]) {
      const d = await getDoc(p);
      if (!d) continue;

      for (const a of d.querySelectorAll('a[href*="/manga-genre/"],a[href*="/genre/"],a[href*="/genres/"]')) {
        const id = pathFromUrl(a.attr("href") || "")
          .replace(/^(manga-genre|genre|genres)\//i, "")
          .replace(/^\/+|\/+$/g, "");
        const name = (a.text() || "").trim();

        if (!id || !name || seen.has(id)) continue;

        seen.add(id);
        out.push({ id, name, group: "Genre" });
      }
    }

    return out;
  },
};

harbor.register(plugin);
