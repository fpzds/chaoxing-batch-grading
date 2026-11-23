#!/usr/bin/env node
/**
 * 学习通（超星）批量批阅脚本
 *
 * 用法示例：
 *   node chaoxing_grade.js --user 账号 --pass 密码 --course "大数据环境部署与运维" --class "大数据2501" --list-only
 *   node chaoxing_grade.js --user 账号 --pass 密码 --course "..." --class "..." --min 90 --max 100
 *
 * 规则：有作答案（文字/图片/附件/链接）→ [min,max] 随机分；空白 → 0 分并列入零分名单。
 */
const fs = require('fs');
const path = require('path');
const os = require('os');

let chromium;
try {
  ({ chromium } = require('playwright'));
} catch (e) {
  console.error('缺少 playwright：请在脚本目录执行 npm i playwright && npx playwright install msedge');
  process.exit(1);
}

/* ---------------- 参数 ---------------- */
const argv = process.argv.slice(2);
const has = f => argv.includes(f);
const opt = (n, d) => {
  const h = argv.find(a => a === n || a.startsWith(n + '='));
  if (!h) return d;
  return h.includes('=') ? h.split('=').slice(1).join('=') : argv[argv.indexOf(h) + 1];
};
const USER = opt('--user', process.env.CHAOXING_USER);
const PASS = opt('--pass', process.env.CHAOXING_PASS);
const COURSE_NAME = opt('--course', '');
const CLASS_NAME = opt('--class', '');
const MIN = Number(opt('--min', 90));
const MAX = Number(opt('--max', 100));
const WORKERS = Number(opt('--workers', 4));
const WORK_ID = opt('--work', '');
const LIST_ONLY = has('--list-only');
const FORCE = has('--force');
const HEADFUL = has('--headful');
const OUT = path.resolve(opt('--out', 'chaoxing-result.json'));
const PROFILE = process.env.CHAOXING_PROFILE || path.join(os.homedir(), '.chaoxing-batch-grading', 'profile');

if (!USER || !PASS) { console.error('需要 --user 和 --pass'); process.exit(1); }
if (!COURSE_NAME) { console.error('需要 --course "课程名"'); process.exit(1); }

const ts = () => new Date().toISOString().slice(11, 19);
const log = (...a) => console.log(ts(), ...a);
const rnd = () => MIN + Math.floor(Math.random() * (MAX - MIN + 1));

/* ---------------- 浏览器 ---------------- */
async function launch() {
  const ctx = await chromium.launchPersistentContext(PROFILE, {
    channel: 'msedge',
    headless: !HEADFUL,
    viewport: { width: 1500, height: 900 },
    args: ['--no-first-run', '--no-default-browser-check', '--lang=zh-CN'],
  });
  ctx.setDefaultTimeout(30000);
  return ctx;
}

const hasUID = async ctx => (await ctx.cookies()).some(c => c.name === 'UID' && c.value);

async function ensureLogin(ctx, page) {
  if (await hasUID(ctx)) return;
  await page.goto('https://passport2.chaoxing.com/login?fid=&newversion=true&refer=https%3A%2F%2Fmooc2-ans.chaoxing.com', { waitUntil: 'domcontentloaded', timeout: 60000 }).catch(() => {});
  await page.waitForTimeout(2000);
  if (await hasUID(ctx)) return;
  await page.locator('#phone').fill(USER).catch(() => {});
  await page.locator('#pwd').fill(PASS).catch(() => {});
  await page.locator('#loginBtn').click({ timeout: 10000 }).catch(() => {});
  for (let i = 0; i < 40; i++) {
    if (await hasUID(ctx)) return;
    await page.waitForTimeout(1000);
  }
  throw new Error('登录失败：可能需要验证码，请用 --headful 手动登录一次后重试');
}

/* ---------------- 定位课程 ---------------- */
async function resolveCourse(page, name) {
  await page.goto('https://mooc1.chaoxing.com/visit/interaction', { waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.waitForTimeout(3500);
  const hit = await page.evaluate(n => {
    const links = [...document.querySelectorAll('a')].filter(a => (a.innerText || '').trim() === n && /isNewCourse/.test(a.getAttribute('href') || ''));
    return links[0] ? links[0].getAttribute('href') : null;
  }, name);
  if (!hit) throw new Error('未找到课程：' + name + '（请确认课程名与账号下一致）');
  await page.goto(hit, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.waitForTimeout(6000);
  const u = new URL(page.url());
  return {
    url: page.url(),
    courseid: u.searchParams.get('courseid'),
    clazzid: u.searchParams.get('clazzid'),
    enc: u.searchParams.get('enc'),
  };
}

/* ---------------- 作业列表（含翻页） ---------------- */
async function readCards(frame) {
  return frame.evaluate(() => [...document.querySelectorAll('li[id^=work]')].map(li => {
    const m = (li.innerText || '').replace(/\s+/g, ' ').match(/(\d+)\u5f85\u6279\s*(\d+)\s*\u5df2\u4ea4\s*(\d+)\s*\u672a\u4ea4/);
    return {
      workId: li.id.replace('work', ''),
      title: ((li.querySelector('.list_li_tit') || {}).innerText || '').trim(),
      pending: m ? Number(m[1]) : -1,
      submitted: m ? Number(m[2]) : -1,
    };
  }));
}

async function collectWorks(page, courseUrl, className) {
  await page.goto(courseUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.waitForTimeout(7000);
  let frame = page.frames().find(f => f.url().includes('work/list'));
  if (!frame) {
    await page.getByText('\u4f5c\u4e1a', { exact: true }).first().click({ timeout: 10000 }).catch(() => {});
    await page.waitForTimeout(6000);
    frame = page.frames().find(f => f.url().includes('work/list'));
  }
  if (!frame) throw new Error('未找到作业列表 iframe');

  const classes = await frame.evaluate(() => [...document.querySelectorAll('li.classli')].map(e => (e.innerText || '').trim()));
  const pick = className || classes.find(c => c !== '\u5168\u90e8\u73ed\u7ea7');
  if (className && !classes.includes(className)) throw new Error('班级不存在。可选：' + classes.join(' / '));
  await frame.evaluate(n => {
    const li = [...document.querySelectorAll('li.classli')].find(e => (e.innerText || '').trim() === n);
    if (li) li.click();
  }, pick);
  await page.waitForTimeout(4500);

  const all = [];
  const seen = new Set();
  for (let p = 1; p <= 6; p++) {
    const cards = await readCards(frame);
    let added = 0;
    cards.forEach(c => { if (c.workId && !seen.has(c.workId)) { seen.add(c.workId); all.push(c); added++; } });
    const moved = await frame.evaluate(n => {
      const li = [...document.querySelectorAll('#page ul li')].find(e => (e.textContent || '').trim() === String(n));
      if (li && !li.className.includes('active')) { li.click(); return true; }
      return false;
    }, p + 1);
    if (!moved || added === 0) break;
    await page.waitForTimeout(4000);
  }
  return { frame, works: all, className: pick };
}

/* ---------------- 单个作业 ---------------- */
const reviewUrl = (c, w, id) => `https://mooc2-ans.chaoxing.com/mooc2-ans/work/library/review-work?courseid=${c.courseid}&clazzid=${c.clazzid}&workId=${w}&workAnswerId=${id}&groupId=0&from=&sort=0&order=0&status=0&pages=1&size=20&topicid=0`;
const listUrl = (c, w) => `https://mooc2-ans.chaoxing.com/mooc2-ans/work/mark?courseid=${c.courseid}&clazzid=${c.clazzid}&id=${w}&cpi=486951922&evaluation=0&from=&v=0&prePageNum=1&prePageSize=20&topicid=0&perspectiveType=0`;

async function answerIds(page, c, work) {
  await page.goto(listUrl(c, work), { waitUntil: 'domcontentloaded', timeout: 45000 });
  await page.waitForTimeout(1800);
  const first = await page.evaluate(() => {
    const a = document.querySelector('a.cz_py');
    const m = a && (a.getAttribute('data') || '').match(/workAnswerId=(\d+)/);
    return m ? m[1] : null;
  });
  if (!first) return [];
  await page.goto(reviewUrl(c, work, first), { waitUntil: 'domcontentloaded', timeout: 45000 });
  await page.waitForTimeout(2000);
  return JSON.parse((await page.locator('#viewAnswerIds').inputValue().catch(() => '[]')) || '[]');
}

const READ = () => {
  const inp = document.querySelector('input.questionScore');
  const qid = inp && inp.getAttribute('rid');
  const dl = qid ? document.getElementById('stuanswer_' + qid) : null;
  const txt = dl ? (dl.innerText || '').replace(/\s+/g, ' ').replace(/^\u5b66\u751f\u7b54\u6848\uff1a?\s*/, '').trim() : '';
  const body = document.body.innerText.replace(/\s+/g, ' ');
  const objM = body.match(/\u5ba2\u89c2\u9898\u5f97\u5206\uff1a\s*([\d.]+)\s*\u5206/);
  return {
    name: (document.getElementById('stuRealName') || {}).value || '',
    status: (document.getElementById('status') || {}).value || '',
    obj: objM ? parseFloat(objM[1]) : 0,
    maxes: [...document.querySelectorAll('input[name^="qscore"]')].map(i => parseFloat(i.value || '0')),
    scores: [...document.querySelectorAll('input.questionScore')].map(i => Number(i.value || 0)),
    len: txt.length,
    imgs: dl ? dl.querySelectorAll('img').length : 0,
    attach: dl ? [...dl.querySelectorAll('iframe')].filter(f => f.getAttribute('filename') || f.getAttribute('objectid')).length : 0,
    links: dl ? [...dl.querySelectorAll('a')].filter(a => /attach|download|\.doc|\.xls|\.zip|\.pdf|\.ppt/i.test(a.getAttribute('href') || '')).length : 0,
  };
};

async function gradeOne(page, c, work, id) {
  const url = reviewUrl(c, work, id);
  try { await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45000 }); }
  catch (e) { await page.waitForTimeout(800); await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45000 }); }
  await page.waitForSelector('input.questionScore', { timeout: 15000 });
  await page.waitForTimeout(250);
  const info = await page.evaluate(READ);

  if (info.status === '4' && !FORCE) return { id, name: info.name, skipped: true };
  const filled = info.len > 0 || info.imgs > 0 || info.attach > 0 || info.links > 0;
  const maxes = info.maxes.length ? info.maxes : [100];
  const subjMax = maxes.reduce((a, b) => a + b, 0);
  const mixed = info.obj > 0;

  let alloc;
  if (mixed) {
    alloc = filled ? maxes.slice() : maxes.map(() => 0);
  } else if (filled) {
    const target = rnd();
    let acc = 0;
    alloc = maxes.map((mx, i) => {
      const v = i === maxes.length - 1 ? Math.max(0, Math.round(target - acc)) : Math.round((target * mx) / subjMax);
      acc += v;
      return Math.min(v, Math.round(mx));
    });
  } else {
    alloc = maxes.map(() => 0);
  }

  const inputs = page.locator('input.questionScore');
  const n = await inputs.count();
  for (let i = 0; i < n; i++) {
    await inputs.nth(i).click({ timeout: 6000 });
    await inputs.nth(i).fill(String(alloc[i] !== undefined ? alloc[i] : 0));
    await page.keyboard.press('Tab');
  }
  await page.evaluate(t => {
    const el = [...document.querySelectorAll('.jb_btn_160,a,div')].find(e => (e.textContent || '').trim() === t && e.getBoundingClientRect().width > 0);
    if (el) el.click();
  }, '\u63d0\u4ea4\u5e76\u8fdb\u5165\u4e0b\u4e00\u4efd');
  await page.waitForTimeout(800);

  let after = { status: '?' };
  try {
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45000 });
    await page.waitForSelector('input.questionScore', { timeout: 12000 });
    await page.waitForTimeout(500);
    after = await page.evaluate(READ);
  } catch (e) { /* ignore */ }
  const total = after.scores ? Number((after.obj + after.scores.reduce((a, b) => a + b, 0)).toFixed(1)) : null;

  return { id, name: info.name, filled, mixed, obj: info.obj, alloc, statusAfter: after.status, total };
}

/* ---------------- 主流程 ---------------- */
(async () => {
  const ctx = await launch();
  const seed = ctx.pages()[0] || (await ctx.newPage());
  await ensureLogin(ctx, seed);

  const course = await resolveCourse(seed, COURSE_NAME);
  log('课程:', COURSE_NAME, '| courseid=' + course.courseid, 'clazzid=' + course.clazzid);
  const { works, className } = await collectWorks(seed, course.url, CLASS_NAME);
  log('班级:', className, '| 作业数:', works.length);

  const targets = WORK_ID
    ? works.filter(w => w.workId === WORK_ID)
    : works.filter(w => w.pending > 0);
  console.log('\n作业清单：');
  works.forEach(w => console.log(`  ${w.workId}  ${w.title.padEnd(16)} 待批 ${String(w.pending).padStart(3)} / 已交 ${w.submitted}${targets.includes(w) ? '   <== 本次处理' : ''}`));
  console.log('');

  if (LIST_ONLY) {
    log('仅列清单（--list-only），未提交任何分数');
    await ctx.close();
    return;
  }
  if (!targets.length) { log('没有待批阅的作业'); await ctx.close(); return; }

  const report = { course: COURSE_NAME, className, range: [MIN, MAX], at: new Date().toISOString(), works: [], zeros: [], capped: [] };

  for (const w of targets) {
    const ids = await answerIds(seed, course, w.workId);
    log(`\n=== ${w.title} (${w.workId}) 答卷 ${ids.length} 份，区间 ${MIN}-${MAX}`);
    let cursor = 0;
    const rows = [];
    const worker = async () => {
      const page = await ctx.newPage();
      page.on('dialog', d => d.accept().catch(() => {}));
      while (true) {
        const i = cursor++;
        if (i >= ids.length) break;
        try {
          if (!(await hasUID(ctx))) await ensureLogin(ctx, page);
          const r = await gradeOne(page, course, w.workId, ids[i]);
          rows.push(r);
          if (!r.skipped) log(`  ${r.name} ${r.filled ? '有作答' : '空白'} -> ${r.total === null ? '?' : r.total}${r.mixed ? ' (含客观题)' : ''}`);
        } catch (e) {
          rows.push({ id: ids[i], error: e.message.slice(0, 60) });
          log('  ERR', e.message.slice(0, 50));
        }
      }
      await page.close().catch(() => {});
    };
    await Promise.all(Array.from({ length: WORKERS }, () => worker()));

    const graded = rows.filter(r => r.total !== undefined && r.total !== null);
    const zeros = graded.filter(r => r.filled === false);
    const capped = graded.filter(r => r.filled && r.total < MIN);
    w.graded = graded.length;
    w.zeros = zeros.map(z => z.name);
    w.capped = capped.map(z => `${z.name} ${z.total}`);
    report.works.push({ workId: w.workId, title: w.title, graded: graded.length, zeros: w.zeros, capped: w.capped });
    report.zeros.push(...zeros.map(z => ({ work: w.title, name: z.name })));
    report.capped.push(...capped.map(z => ({ work: w.title, name: z.name, total: z.total })));
    log(`  --> 完成 ${graded.length} 份，空白 ${zeros.length}，客观题受限 ${capped.length}`);
  }

  fs.writeFileSync(OUT, JSON.stringify(report, null, 2));
  console.log('\n===== 汇总 =====');
  report.works.forEach(w => console.log(`${w.title}: 批阅 ${w.graded} 份${w.zeros.length ? `，空白: ${w.zeros.join(',')}` : ''}${w.capped.length ? `，未达下限: ${w.capped.join(',')}` : ''}`));
  console.log(report.zeros.length ? `\n零分名单（${report.zeros.length}）：` + report.zeros.map(z => `${z.name}(${z.work})`).join('、') : '\n零分名单：无');
  if (report.capped.length) console.log(`客观题失分导致低于 ${MIN} 分：` + report.capped.map(z => `${z.name} ${z.total}(${z.work})`).join('、'));
  console.log('\n结果已写入', OUT);
  await ctx.close();
})();
