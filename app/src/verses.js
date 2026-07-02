// iOS 앱/위젯의 DailyVerseProvider.swift 와 pool·해시 알고리즘이 반드시 일치해야 한다.
// (앱이 실행되지 않은 날에도 서버가 동일한 "오늘의 말씀"을 계산해 Live Activity로 띄우기 위함)

const POOL = [
  { subject: "시편 23:1", bible: "여호와는 나의 목자시니 내게 부족함이 없으리로다" },
  { subject: "요한복음 3:16", bible: "하나님이 세상을 이처럼 사랑하사 독생자를 주셨으니 이는 그를 믿는 자마다 멸망하지 않고 영생을 얻게 하려 하심이라" },
  { subject: "빌립보서 4:13", bible: "내게 능력 주시는 자 안에서 내가 모든 것을 할 수 있느니라" },
  { subject: "이사야 40:31", bible: "오직 여호와를 앙망하는 자는 새 힘을 얻으리니 독수리가 날개치며 올라감 같을 것이요 달음박질하여도 곤비하지 아니하겠고 걸어가도 피곤하지 아니하리로다" },
  { subject: "예레미야 29:11", bible: "여호와의 말씀이니라 너희를 향한 나의 생각을 내가 아나니 평안이요 재앙이 아니니라 너희에게 미래와 희망을 주는 것이니라" },
  { subject: "마태복음 5:3", bible: "심령이 가난한 자는 복이 있나니 천국이 그들의 것임이요" },
  { subject: "로마서 8:28", bible: "우리가 알거니와 하나님을 사랑하는 자 곧 그의 뜻대로 부르심을 입은 자들에게는 모든 것이 합력하여 선을 이루느니라" },
  { subject: "시편 46:10", bible: "이르시기를 너희는 가만히 있어 내가 하나님 됨을 알지어다 내가 뭇 나라 중에서 높임을 받으리라 내가 세계 중에서 높임을 받으리라 하시도다" },
  { subject: "잠언 3:5-6", bible: "너는 마음을 다하여 여호와를 신뢰하고 네 명철을 의지하지 말라 너는 범사에 그를 인정하라 그리하면 네 길을 지도하시리라" },
  { subject: "고린도전서 13:13", bible: "그런즉 믿음, 소망, 사랑 이 세 가지는 항상 있을 것인데 그 중의 제일은 사랑이라" },
];

const MASK64 = (1n << 64n) - 1n;

// Swift stableHash(djb2)와 동일: UInt64 오버플로를 64비트로 마스킹
function stableHash(str) {
  let hash = 5381n;
  for (const byte of Buffer.from(str, "utf8")) {
    hash = (hash * 33n + BigInt(byte)) & MASK64;
  }
  return hash;
}

// date: "YYYY-MM-DD"
function dailyVerse(dateString, userId) {
  const count = POOL.length;
  if (count === 0) {
    return { subject: "", bible: "", translation: "개역개정", date: dateString };
  }
  const index = Number(stableHash(`${userId}|${dateString}`) % BigInt(count));
  const item = POOL[index];
  return {
    subject: item.subject,
    bible: item.bible,
    translation: "개역개정",
    date: dateString,
  };
}

module.exports = { POOL, dailyVerse, stableHash };
