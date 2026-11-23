# chaoxing-batch-grading

学习通（超星）**教师端批量批阅**工具：无头浏览器 + 多标签并发，按“有作答给区间随机分、空白给 0 分并通报”的规则自动评分、提交、复核。

## 安装

```bash
npm i playwright
npx playwright install msedge     # 或 npx playwright install chromium
```

## 用法

```bash
# 1) 先预演，只列作业和待批数量（不提交任何分数）
node chaoxing_grade.js --user 账号 --pass 密码 \
  --course "大数据环境部署与运维" --class "大数据2501" --list-only

# 2) 正式批阅：90-100 随机分，4 标签并发
node chaoxing_grade.js --user 账号 --pass 密码 \
  --course "大数据环境部署与运维" --class "大数据2501" \
  --min 90 --max 100 --workers 4

# 3) 只批某一次作业
node chaoxing_grade.js ... --work 56997269
```

参数：

| 参数 | 说明 |
|---|---|
| `--user` / `--pass` | 教师账号（也可用环境变量 `CHAOXING_USER` / `CHAOXING_PASS`） |
| `--course` | 课程名，须与账号下一致 |
| `--class` | 班级名，如“大数据2501” |
| `--min` / `--max` | 分数区间，默认 90–100 |
| `--workers` | 并发标签数，默认 4，建议 ≤6 |
| `--list-only` | 只列清单不提交 |
| `--work` | 只处理指定 workId |
| `--force` | 重批已批阅的（默认跳过，绝不覆盖人工分） |
| `--headful` | 显示浏览器（首次登录/验证码时用） |
| `--out` | 结果 JSON 路径 |

## 评分规则

- **有作答**：文字、图片、附件（docx / xlsx / zip / pdf / mp4，通过附件 iframe 的 `filename`、`objectid` 识别）、下载链接，命中任一即可 → 在 `[min,max]` 内随机取整
- **空白**：以上全无 → 0 分，并列入最终“零分名单”
- **多题作业**：按每题满分比例分摊目标分
- **混合题型**（含客观题自动得分）：总分 = 客观分 + 主观分；主观给满分。若客观分过低导致上限不足 `min`，报告里单列“客观题受限”
- **已批阅**（status=4）默认跳过，不覆盖

## 输出

终端按作业汇总，并写出 `chaoxing-result.json`：

```
第12周第1次作业: 批阅 38 份
零分名单：张三(第10周1次)、李四(第11周2次)
客观题受限：王五 85.6(第7周2次)
```

## 注意

- 批阅即写入真实成绩，先 `--list-only` 核对范围
- 高频请求可能触发验证码/限流，`--workers` 不建议超过 6
- 账号密码仅用于登录，勿写入代码或提交到仓库
- 登录态保存在 `~/.chaoxing-batch-grading/profile`，可复用

## 作为 DSH Skill 使用

把 `SKILL.md` 与 `chaoxing_grade.js` 放进 `~/.dsh/skills/chaoxing-batch-grading/`，AI 助手会在你提出“批量批阅学习通作业”时自动加载，并按 SKILL.md 的流程先向你确认账号、课程、班级、范围和分数区间。
