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

async function getRaw(path, options = {}) {
  const res = await harbor.http(BASE + path, {
    responseType: "text",
    ...options,
  });
  return res.ok ? (res.body || "") : "";
}

async function getDoc(path, options = {}) {
  const raw = await getRaw(path, options);
  return raw ? harbor.parseHtml(raw) : null;
}

function text(root, selectors) {
  for (const selector of selectors) {
    const el = root.querySelector(selector);
    const value = el ? (el.text() || "").trim() : "";
    if (value) return value;
  }
  return "";
}

function meta(doc, names) {
  const wanted = names.map((x) => x.toLowerCase());
  for (const m of doc.querySelectorAll("meta")) {
    const key = ((m.attr("property") || m.attr("name") || "") + "").toLowerCase();
    if (wanted.includes(key)) return (m.attr("content") || "").trim();
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

function cover(doc) {
  const m = meta(doc, ["og:image", "twitter:image", "twitter:image:src"]);
  if (m) return abs(m);

  for (const selector of [
    ".summary_image img",
    ".summary-image img",
    ".summary_image a img",
    ".post-thumbnail img",
    ".tab-summary .summary_image img",
  ]) {
    const u = imageUrl(doc.querySelector(selector));
    if (u) return u;
  }

  return undefined;
}

function isChapterHref(href) {
  if (!href) return false;
  return (
    /\/manga\/[^/]+\/\d+(?:\.\d+)?\/?(?:\?.*)?$/i.test(href) ||
    /\/chapter[\s._-]*\d+/i.test(href) ||
    /\/chapter\//i.test(href)
  );
}

function chapterNumber(textValue, href) {
  const source = `${textValue || ""} ${href || ""}`;
  const patterns = [
    /chapter[\s._-]*(\d+(?:\.\d+)?)/i,
    /\bch[\s._-]*(\d+(?:\.\d+)?)/i,
    /\/([0-9]+(?:\.[0-9]+)?)\/?(?:\?|$)/,
  ];

  for (const re of patterns) {
    const m = source.match(re);
    if (m) return m[1];
  }
  return null;
}

function parseChapterList(doc) {
  const out = [];
  const seen = new Set();

  const add = (a) => {
    const href = a.attr("href") || "";
    if (!href) return;

    const id = pathFromUrl(href);
    const title = (a.text() || a.attr("title") || "").trim();
    const num = chapterNumber(title, href);

    if (!id || seen.has(id) || !num) return;

    seen.add(id);

    out.push({
      id,
      chapter: num,
      title: title || `الفصل ${num}`,
      volume: a.attr("data-volume") || a.attr("data-vol") || null,
      pages: 0,
      // Harbor filters chapters by source language in some versions.
      // 3asq content is Arabic, but "en" keeps it visible in Harbor.
      language: "en",
    });
  };

  // This is the actual Madara chapter-list structure returned by AJAX.
  for (const li of doc.querySelectorAll("li.wp-manga-chapter")) {
    const a = li.querySelector("a");
    if (a) add(a);
  }

  // Fallback selectors for different Madara themes.
  for (const selector of [
    ".wp-manga-chapter a",
    ".wp-manga-chapters a",
    ".chapter-list a",
    ".version-chap a",
    ".listing-chapters_wrap a",
    ".chapter-item a",
  ]) {
    for (const a of doc.querySelectorAll(selector)) add(a);
  }

  out.sort((a, b) => {
    const na = parseFloat(a.chapter);
    const nb = parseFloat(b.chapter);
    if (Number.isFinite(na) && Number.isFinite(nb)) return nb - na;
    return 0;
  });

  return out;
}

function mangaIdFromPage(doc) {
  const holder = doc.querySelector('div[id^="manga-chapters-holder"]');
  return holder ? (holder.attr("data-id") || "").trim() : "";
}

async function fetchAjaxChapters(mangaPath, mangaId) {
  const headers = {
    Referer: BASE + "/" + String(mangaPath).replace(/^\/+/, ""),
    "X-Requested-With": "XMLHttpRequest",
  };

  // Old Madara endpoint. It is handled by WordPress and is also commonly
  // used by Madara-based manga clients to retrieve the complete chapter list.
  if (mangaId) {
    const raw = await getRaw(
      `/wp-admin/admin-ajax.php?action=manga_get_chapters&manga=${encodeURIComponent(mangaId)}`,
      { headers }
    );

    if (raw) {
      const doc = harbor.parseHtml(raw);
      const chapters = parseChapterList(doc);
      if (chapters.length) return chapters;
    }
  }

  // Newer Madara endpoint.
  const clean = String(mangaPath).replace(/^\/+|\/+$/g, "");
  if (clean) {
    const raw = await getRaw(`/${clean}/ajax/chapters`, { headers });
    if (raw) {
      const doc = harbor.parseHtml(raw);
      const chapters = parseChapterList(doc);
      if (chapters.length) return chapters;
    }
  }

  return [];
}

function summaries(doc) {
  const out = [];
  const seen = new Set();

  for (const selector of [
    ".page-item-detail",
    ".c-tabs-item__content .page-item-detail",
    ".bsx",
    ".manga-item",
    "article",
  ]) {
    for (const card of doc.querySelectorAll(selector)) {
      let link = null;

      for (const a of card.querySelectorAll("a")) {
        const href = a.attr("href") || "";
        if (/\/manga\//i.test(href) && !isChapterHref(href)) {
          link = a;
          break;
        }
      }

      if (!link) continue;

      const id = pathFromUrl(link.attr("href") || "");
      const title = (
        link.attr("title") ||
        link.text() ||
        text(card, ["h2", "h3", ".title", ".post-title"])
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
  const tag = tagId ? encodeURIComponent(tagId) : "";

  if (kind === "popular") {
    if (tag) {
      return [
        `/manga-genre/${tag}/?m_orderby=views&page=${page}`,
        `/genre/${tag}/?m_orderby=views&page=${page}`,
      ];
    }

    return [
      `/manga/?m_orderby=views&page=${page}`,
      `/manga/page/${page}/?m_orderby=views`,
    ];
  }

  if (tag) {
    return [
      `/manga-genre/${tag}/?s=${q}&post_type=wp-manga&page=${page}`,
      `/genre/${tag}/?s=${q}&post_type=wp-manga&page=${page}`,
    ];
  }

  return [
    `/manga/?s=${q}&post_type=wp-manga&page=${page}`,
    `/?s=${q}&post_type=wp-manga&page=${page}`,
  ];
}

async function pageUrls(id) {
  const clean = String(id).replace(/^\/+/, "");
  const doc = await getDoc("/" + clean);
  if (!doc) return [];

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
    for (const image of doc.querySelectorAll(selector)) {
      const u = imageUrl(image);
      if (!u || seen.has(u)) continue;
      seen.add(u);
      out.push(u);
    }
  }

  return out;
}

const plugin = {
  id: "3asq-online",
  name: "3asq.online",

  async popular(offset, tagId) {
    const page = Math.floor(offset / 48) + 1;

    for (const p of listingPaths("popular", page, "", tagId)) {
      const doc = await getDoc(p);
      if (!doc) continue;
      const items = summaries(doc);
      if (items.length) return items;
    }

    return [];
  },

  async search(query, offset, tagId) {
    const page = Math.floor(offset / 48) + 1;

    for (const p of listingPaths("search", page, query, tagId)) {
      const doc = await getDoc(p);
      if (!doc) continue;
      const items = summaries(doc);
      if (items.length) return items;
    }

    return [];
  },

  async detail(id) {
    const clean = String(id).replace(/^\/+/, "");
    const doc = await getDoc("/" + clean);
    if (!doc) return null;

    const yearText = text(doc, [
      ".year",
      ".release-year",
      ".summary-content.year",
    ]);
    const yearMatch = yearText.match(/\b(19\d{2}|20\d{2})\b/);

    return {
      id,
      title:
        text(doc, [
          ".post-title h1",
          ".summary-title h1",
          "h1.entry-title",
          "h1",
        ]) || meta(doc, ["og:title", "twitter:title"]) || id,
      altTitle:
        text(doc, [".alternative", ".alt-title"]) || undefined,
      cover: cover(doc),
      year: yearMatch ? Number(yearMatch[1]) : undefined,
      status:
        text(doc, [
          ".post-status .summary-content",
          ".summary-content.status",
          ".post-content_item.manga-status .summary-content",
        ]) || undefined,
      description:
        meta(doc, ["og:description", "twitter:description", "description"]) ||
        text(doc, [
          ".summary__content",
          ".summary_content",
          ".summary-content",
          ".description-summary",
        ]),
      lastChapter:
        text(doc, [
          ".wp-manga-chapter a",
          ".wp-manga-chapters a",
          ".chapter-list a",
        ]) || undefined,
      author:
        text(doc, [
          ".author-content",
          ".author",
          ".summary-content.author",
          ".post-content_item.manga-authors .summary-content",
        ]) || undefined,
    };
  },

  async chapters(id) {
    const clean = String(id).replace(/^\/+/, "");
    const mangaDoc = await getDoc("/" + clean);
    if (!mangaDoc) return [];

    // First try the real Madara AJAX chapter list.
    const mangaId = mangaIdFromPage(mangaDoc);
    const ajax = await fetchAjaxChapters(clean, mangaId);
    if (ajax.length) return ajax;

    // Fallback if the server exposes chapters directly in the page HTML.
    return parseChapterList(mangaDoc);
  },

  async pageUrls(chapterId) {
    return await pageUrls(chapterId);
  },

  async tags() {
    const out = [];
    const seen = new Set();

    for (const p of ["/manga-genre/", "/genre/", "/genres/", "/"]) {
      const doc = await getDoc(p);
      if (!doc) continue;

      for (const a of doc.querySelectorAll(
        'a[href*="/manga-genre/"],a[href*="/genre/"],a[href*="/genres/"]'
      )) {
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
