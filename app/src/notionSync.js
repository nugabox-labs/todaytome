const { Client } = require("@notionhq/client");
const { prisma } = require("./db");

// Notion "Jesus Today" 데이터베이스 (mics-api 프로젝트의 src/faith.js와 동일한 DB)
const DATABASE_ID = process.env.NOTION_FAITH_DATABASE_ID || "39e2135fbb534d55a991dc2a5510eac7";

function getClient() {
  if (!process.env.NOTION_API_KEY) return null;
  return new Client({ auth: process.env.NOTION_API_KEY, notionVersion: "2022-06-28" });
}

function plainText(richTextArray) {
  return (richTextArray || []).map((t) => t.plain_text).join("");
}

// 전체 페이지 조회 — 중간에 실패하면 예외를 던져 부분 목록으로 DB를 덮어쓰지 않는다.
async function fetchAllPages(notion) {
  const pages = [];
  let cursor;
  do {
    const res = await notion.databases.query({
      database_id: DATABASE_ID,
      start_cursor: cursor,
      page_size: 100,
    });
    pages.push(...res.results);
    cursor = res.has_more ? res.next_cursor : undefined;
  } while (cursor);
  return pages;
}

// Notion DB 전체를 읽어 로컬 pool 테이블과 동기화 (upsert + 삭제된 항목 정리)
async function syncVerseBank() {
  const notion = getClient();
  if (!notion) {
    console.warn("[notion] NOTION_API_KEY not configured, skipping sync");
    return { synced: 0, skipped: true };
  }

  const pages = await fetchAllPages(notion);
  const seenIds = [];

  for (const page of pages) {
    const subject = plainText(page.properties?.["이름"]?.title).trim();
    const bible = plainText(page.properties?.["본문"]?.rich_text).trim();
    if (!subject || !bible) continue; // 제목/본문이 비어있는 항목은 pool에서 제외

    const sourceDateStr = page.properties?.["날짜"]?.date?.start || null;

    await prisma.notionVerse.upsert({
      where: { notionPageId: page.id },
      create: {
        notionPageId: page.id,
        subject: subject.slice(0, 200),
        bible,
        sourceDate: sourceDateStr ? new Date(sourceDateStr) : null,
      },
      update: {
        subject: subject.slice(0, 200),
        bible,
        sourceDate: sourceDateStr ? new Date(sourceDateStr) : null,
      },
    });
    seenIds.push(page.id);
  }

  const { count: removed } = await prisma.notionVerse.deleteMany({
    where: { notionPageId: { notIn: seenIds } },
  });

  console.log(`[notion] synced ${seenIds.length} verses (removed ${removed} stale)`);
  return { synced: seenIds.length, removed };
}

const SYNC_INTERVAL_MS = 60 * 60 * 1000; // 매시간

function start() {
  syncVerseBank().catch((error) => console.error("[notion] initial sync failed:", error.message));
  setInterval(() => {
    syncVerseBank().catch((error) => console.error("[notion] sync failed:", error.message));
  }, SYNC_INTERVAL_MS);
  console.log("[notion] sync scheduled (hourly)");
}

module.exports = { start, syncVerseBank };
