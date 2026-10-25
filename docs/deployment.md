# 部署指南（Deployment & Rollout）

本文件是 Gateway fleet rollout 與 dsh credentials 同步的操作手冊。
Gateway 共 **八台**：Mac、mazu、athena、cthulhu、valkyrie、Oracle、Zeus、swop。
更新 Swear Review 不代表 Gateway 已更新；只更新磁碟檔案也不代表程序已更新。

## 1. 建置與部署共同規則

在 Mac arm64 上，從乾淨、已驗證的提交建立獨立 worktree，再建置四種平台執行檔：

```bash
bun install --frozen-lockfile
bun run build:all
bun build --compile --minify --target=bun-windows-x64 --outfile=dist/deepseek-gateway.exe src/index.ts
codesign --force --sign - dist/deepseek-gateway
codesign --verify --strict dist/deepseek-gateway
shasum -a 256 dist/deepseek-gateway*
```

Mac 的 SHA-256 必須在簽章之後計算。Windows build 是額外步驟，目前
`build:all` 只包含 Mac、Linux x64 與 Linux ARM64。

| binary | 目標 |
|---|---|
| `dist/deepseek-gateway` | Mac arm64 |
| `dist/deepseek-gateway-linux-x64` | mazu、athena、cthulhu、valkyrie、Zeus |
| `dist/deepseek-gateway-linux-arm64` | Oracle ARM64 |
| `dist/deepseek-gateway.exe` | swop Windows x64 |

每次改版都必須：

1. 核對 live executable path、supervisor、port 與既有連線，不能只沿用舊機器清單。
2. 保留各機 config、launcher、憑證與 supervisor 定義；binary-only 更新不得複製範例設定覆蓋它們。
3. 在正式路徑外測試候選 binary，核對 SHA-256，備份並驗證舊 binary。
4. 將候選檔複製到正式 binary 的同目錄暫存檔，再原子替換；不要直接覆寫正在執行的檔案。
5. 等該 Gateway 的 established 連線清空後，只重啟該 Gateway；保留 HAPI Runner 與其他工作階段。
6. 驗證新 PID／啟動時間、實際 executable、SHA-256、health、header 轉送及真實推論，最後清理候選暫存並保留回復備份。

## 2. 八台服務與位置

| 機器 | arch | 正式 binary | supervisor | port |
|---|---|---|---|---|
| Mac | arm64 | `~/.local/bin/deepseek-gateway` | LaunchAgent `com.swear.deepseek-gateway` | 35001 |
| mazu / athena / cthulhu / valkyrie | x64 | `~/.local/bin/deepseek-gateway`，四台 NFS 共用檔案 | 各台 user systemd `deepseek-gateway` | 35001 |
| Oracle | ARM64 | `~/.local/bin/deepseek-gateway` | user systemd `deepseek-gateway` | 35001 |
| Zeus（swear02） | x64 | `~/.local/bin/deepseek-gateway` | user systemd `deepseek-gateway` | 35002 |
| swop | Windows x64 | `%ProgramData%\DeepSeekGateway\deepseek-gateway.exe` | SYSTEM Scheduled Task `DeepSeek Gateway (SWOP)` | 35001 |

所有服務綁定 loopback。Zeus 是獨立 home，必須另外安裝；NFS 四台只替換
一次檔案，但必須逐台重啟及驗證自己的程序。

## 3. Mac 與 Linux

Mac 在完成備份、簽章驗證、原子替換及連線清空檢查後，用原有 LaunchAgent：

```bash
launchctl kickstart -k gui/$(id -u)/com.swear.deepseek-gateway
curl -fsS http://127.0.0.1:35001/health
```

Linux 先 scp 到各目的主機的任務暫存目錄，再複製到正式 binary 的同目錄
暫存檔後 rename。`/tmp` 可能與 home 不同 filesystem，不能假設跨目錄
`mv` 本身是原子操作。四台 NFS 主機只經 mazu 替換一次；Oracle、Zeus 各自替換。

每台在沒有進行中連線後重啟並驗證（Zeus 的 health 改用 port 35002）：

```bash
systemctl --user restart deepseek-gateway
systemctl --user is-active deepseek-gateway
gateway_pid=$(systemctl --user show deepseek-gateway -p MainPID --value)
sha256sum ~/.local/bin/deepseek-gateway /proc/"$gateway_pid"/exe
curl -fsS http://127.0.0.1:35001/health
```

兩個 SHA-256 都必須等於該平台的候選 hash；只檢查磁碟檔案不足以證明新程序。

## 4. swop（Windows SYSTEM 排程）

正式 launcher 為 `%ProgramData%\DeepSeekGateway\deepseek-gateway-system.ps1`。
保留 SYSTEM principal、BootTrigger、排程 XML、config 與 LocalMachine
DPAPI credentials。不要切換成登入使用者的臨時程序。

1. 先對 Windows 候選 exe 執行隔離的 header 封包測試，核對 hash。
2. 備份正式 exe 與 `%USERPROFILE%\.local\bin\deepseek-gateway.exe` 副本，將候選檔放到各目標旁邊。
3. 確認 port 35001 無 established 連線，停止 `DeepSeek Gateway (SWOP)`。若舊 child 未退出，只停止 executable path 已核對的 Gateway PID。
4. 用 `[IO.File]::Replace` 替換兩份 binary，第三個參數使用明確的備份路徑。Windows PowerShell 可能把 `$null` 轉為空字串，造成 `The path is not of a legal form`。
5. 啟動原排程，確認新 PID、正式 executable path、兩份 binary hash、health，以及設定與排程 XML 未變。失敗則恢復已驗證的備份，再啟動原排程。

## 驗證邊界與最新部署紀錄

### 設定格式遷移（2026-10-25 簡化 router）

新版只讀單一 `config.yaml`（`providers` + `models`）；舊的 `endpoints` 清單與
`routing.yaml` 會在啟動時被拒絕（`'providers' must map provider ids to settings`）。
換 binary 前必須先把該機 live config 轉成新格式：每個舊 endpoint 變成
`providers.<id>`（保留 `base_url`、`api_key` 的 `${VAR}`、`compat`、`extra_body`、
`extra_headers`；`name`、`weight`、`models`、`model_map` 不再使用），`models` 依
`config.example.yaml` 只留 `deepseek-flash` 與 `deepseek-pro`，`server` 保留該機的
port。舊 `routing.yaml` 改名備份即可，新版不讀。binary 與 config 必須一起換：
舊 binary 讀不了新格式，新 binary 讀不了舊格式。

2026-10-25（台灣時間）部署 PR #26（merge `1c5f811`）：帶前綴、版本或日期的 DeepSeek id
（如 `deepseek-v4-flash`、`deepseek-v4.1-flash-1017`、`deepseek/deepseek-v4-pro`、`~deepseek/deepseek-flash-latest`）
alias 到無前後綴的 `deepseek-flash`／`deepseek-pro`；`-fast`、`-vision-exp` 與無關名稱仍回 400 `model_not_allowed`。

- 完成並驗證 7 個 Gateway：mazu、zeus（swear01，35001）、cthulhu、valkyrie（NFS 共用 binary，
  只換一次、逐台重啟；config 不變）、Zeus（swear02，35002）、Oracle（只換 binary）、Mac（同時從舊格式遷移
  binary 與 config，`routing.yaml` 改名 `routing.yaml.retired-20261025`，回復點 `*.bak-20261025-gw2`）。
  其餘主機回復點為 `deepseek-gateway.bak-20261025-gw3`。
- 每台：新 PID、執行中 binary SHA-256 與建置結果相符（Linux x64 `76c6955aea2a…`，Zeus 自建相同；
  Linux ARM64 `6aee39870956…`；Mac 簽章後 `41bb28c2fa8d…`）；52 tests 通過；`verify.sh` 9/9 PASS：
  `/v1/models` 只有 `deepseek-flash`、`deepseek-pro`，這兩者與 `deepseek-v4-flash`、`deepseek-v4.1-flash-1017`、
  `deepseek-v4-pro` 皆 HTTP 200 且上游為對應 family（當時由 `command-code` 回答），
  `deepseek-v4-flash-vision-exp`、`gpt-5` 回 400。Mac `check-latest` 7/7 ok。
- `verify.sh` 拒絕檢查原本以 `'$$'` 拼接 python 引號，macOS bash 3.2 不展開，已改為以參數傳檔名。
- 未部署：swop（不在 HAPI 機器列表；Mac 經 `Host swop` 118.150.242.12:22 SSH timeout）、Athena（送修排除）。

2026-10-25（台灣時間）部署 PR #24（merge `3042db6`）簡化 router：binary 與 config 同時更換，
各機 config 以本機一次性部署工具 `convert.ts`（不在 repo；逐一照上方遷移規則轉換）轉成 `providers` + `models` 格式（保留各機 server、endpoint 欄位與
`${VAR}` key 參照），`routing.yaml` 改名為 `routing.yaml.retired-20261025`，回復點為
`*.bak-20261025-gw2`。各機驗證用的 `verify.sh` 也是不在 repo 的本機腳本，內容為下列 HTTP 檢查。

- 完成並驗證 6 個 Gateway：mazu、zeus（swear01，35001）、cthulhu、valkyrie（四台 NFS 共用檔案，
  mazu 替換一次後逐台重啟）、Zeus（swear02，35002）、Oracle（各自從 `3042db6` 建置）。
- 每台：新 PID、執行中 binary SHA-256 與磁碟相符（Linux x64 `9e44627e1ef8…`，Zeus 自建結果相同；
  Linux ARM64 `9a0af84eb842…`）；`verify.sh` 全 PASS：`/v1/models` 只有 `deepseek-flash`、`deepseek-pro`，
  兩者 HTTP 200（當時由 `command-code` 回答），`deepseek-v4-flash`、`deepseek-v4.1-flash-1017`、
  `deepseek-v4-pro` 回 400 `model_not_allowed`；`check-latest` 對 live config 7/7 ok
  （flash-latest → `deepseek/deepseek-v4.1-flash-1017`，pro-latest → `deepseek/deepseek-v4-pro-0813`）。
- 部署前以候選 binary 在 port 35994 實測；另以隔離實例把 OpenCode／Command Code 指向不可連線位址，
  `deepseek-flash` 改由 OpenRouter latest 回答。
- 當時 OpenCode Go 帳號 1 週額度用盡、帳號 2／3 key 過期（401），三者每次失敗後各 cooldown 30 分鐘。
- 未部署：Mac（不在 HAPI 機器列表，離線；已於 PR #26 部署時遷移）、swop（離線）、Athena（送修排除）。
  未遷移的機器仍跑舊 binary＋舊設定，恢復後須照上方遷移步驟同時更換 binary 與 config。

2026-10-25（台灣時間）部署 PR #21（merge `8a9e06f`）的設定變更，binary 不變：
`deepseek-flash` 的 OpenRouter fallback 改為 `deepseek/deepseek-v4.1-flash-1017`，
新增只走 OpenRouter 1017 的 `deepseek-v4.1-flash-1017`，移除 `deepseek-v4-flash`
route 與 allow 項目。各機以語意編輯 live `config.yaml`／`routing.yaml`（保留各自的
endpoint、port、key），先備份 `.bak-<ts>`，port 無 established 連線後只重啟 Gateway。

- 完成並驗證 7 個 Gateway：mazu、cthulhu、valkyrie、zeus（swear01，35001）、
  Zeus（swear02，35002）、Oracle、Mac。mazu／cthulhu／valkyrie／zeus(swear01)
  讀同一份 NFS 設定檔，只改一次，各自重啟。
- 每台：新 PID、磁碟與執行中 binary SHA-256 相符（Linux x64 `452093eaa9a0…`、
  Linux ARM64 `81e6274b9b80…`、Mac `9e24fc4d82b4…`）、新程序的 `[Routing]` 行含
  `deepseek-v4.1-flash-1017: 1:openrouter-1017`；`deepseek-v4.1-flash-1017` 實測 HTTP 200、
  回應 `model` 為 `deepseek/deepseek-v4.1-flash-1017`（`openrouter`）；`deepseek-v4-flash`
  回 400 `model_not_allowed`；`deepseek-flash` 200（當時由 `command-code` 回答）。
- `deepseek-flash` 的 OpenRouter fallback 另以 mazu 部署中的 binary 與 live 設定起隔離實例
  （port 35998，OpenCode／Command Code 的 `base_url` 指向不可連線位址）驗證：3/3 請求
  HTTP 200，回應 `model` 為 `deepseek/deepseek-v4.1-flash-1017`。其餘主機 routing 相同、
  binary 同版，未逐台重做。
- 各機 live client 設定（Pi、dsh、opencode、Codex、Swear Review）都已用 `deepseek-flash`，
  無需遷移；Pi `models-store.json` 內的 `deepseek-v4-flash` 是 opencode 上游目錄，不是本 Gateway。
- 未部署：Athena（送修，依 fleet 政策排除）、swop（不在 HAPI 機器列表，外部 SSH timeout）。

2026-10-12（台灣時間）在 Oracle 部署 subscription-403 修復程式
`1a07a91`：OpenCode Go 帳號 1 回 monthly quota 429、帳號 2 回訂閱失效
403 時，Gateway 繼續嘗試帳號 3。候選 port 35011 與正式 port 35001 均
實測 HTTP 200、`X-Gateway-Active-Endpoint: opencode-go-3`、
`X-Gateway-Attempt: 3`，模型完整回答 `OK`。

- 65 tests、typecheck、四平台建置及 Mac 簽章驗證通過。
- Oracle 正式磁碟檔案與新程序 `/proc/1112807/exe` 的 SHA-256 均為
  `2d82b6a680444f46847cdbe6c4447e7d25b812b1a8a8ccfa56e39321cc288691`。
- config、routing、launcher、systemd unit hash 保持一致；舊 binary 已備份。
  Swear Review 程序保持 PID 4173895，沒有重啟。
- 本次只部署故障所在的 Oracle；其餘七台未更新，仍以先前部署紀錄為準。

2026-09-23 已部署 PR #16 合併提交 `9861158`（fix head `0b62f76`）至
Mac、四台 NFS（mazu、athena、cthulhu、valkyrie）、Oracle、Zeus（swear02）。
本次修復當 client 端送出 `Python-urllib` 或 generic library User-Agent
時，Cloudflare 於 API key 驗證前阻擋引發 HTTP 403 / Error 1010，且 gateway
未 failover 卡死在 opencode-go-1 的問題：
1. Outbound 預設帶上 `User-Agent: aisimpv-gateway/1.0`，正規化缺失或 generic 函式庫
   User-Agent（如 `python-urllib/*`、`python-requests/*` 等），同時保留自定義 agent
   User-Agent 與 endpoint 自訂 `extraHeaders`。
2. 保持穩定 session identifiers（`x-opencode-session`），支援 `x-conversation-id` 與 `conversation_id`。
3. 對帶有 JSON body 之 request 自動確保帶上 `Content-Type: application/json`。
4. 將 Cloudflare 1010 / WAF 封鎖視為 endpoint 失敗：記錄 warning，進入暫時 cooldown（基礎 30 秒 backoff），並立即 failover 至下一組 provider/endpoint。

SHA-256（Mac 為簽章後）：

- Mac arm64 `725ab7956b7aadc873aac54d7206537431d736a05254b83a3e27815960ac5cc1`
- Linux x64 `a99874c9cc6ff47b00c4c18fd6efeb1c49a47d341e91653e7c72373cd57e79f8`
- Linux ARM64 `1a02f1eee445c08fc2a419d55404cfc4464a6a56bc82f38b9e1b3852976eeba3`
- Windows x64 `09132180fb53a08999ef22a0ae282155c0080eda0847faca2c2711f7f3731a37`（已建置，未安裝）

驗證紀錄：
- 61 tests、typecheck、四平台建置通過。
- 七台 Linux/Mac 的磁碟與 `/proc/<pid>/exe`（Mac 為 LaunchAgent 新 PID + 已簽章 binary）SHA-256 吻合。
- 各機以 `User-Agent: Python-urllib/3.14` 進行真實 `deepseek-flash` 推論測試，皆成功穿透 Cloudflare，HTTP 200 回應於 `opencode-go-1`（`X-Gateway-Attempt: 1`）。
- swop 未部署：Windows exe 已建置但主機目前離線未安裝。

先前 2026-09-12 的 PR #14 / `9507d17` priority exhaust 與 OpenRouter fallback rollout、
與 2026-09-07 的 PR #10 / `73f0fb5` 八台 session-header rollout 仍是該
契約的基準；本次同時換 binary 與 live routing/config。

Header 契約與 fallback 限制見 README 的 session header 說明。必須涵蓋
caller ID 保留、DSH/Pi alias、重試與後續對話穩定性；沒有 ID 時的開場雜湊
是 heuristic，精確對話隔離仍需 client 傳入穩定 ID。

重啟會重設 priority latch：先嘗試 OpenCode，耗盡後使用 CommandCode。
Cooldown 從 1.5 小時開始，到期後由下一筆 request 探測高優先級路由。

---

## 5. DeepSeek Harness（dsh）credentials 同步契約

dsh 的 key 解析：`settings.yaml` 的 `apiKeyEnv` → 先查 launch 環境變數，
再查 `~/.dsh/.credentials.yaml`。**兩邊名字不一致 = MISSING_CREDENTIAL**。

### 5.1 Key 命名契約

| 名稱 | 意義 |
|---|---|
| `OPENCODE_API_KEY` | legacy 名稱，值 == `OPENCODE_API_KEY_1` |
| `OPENCODE_API_KEY_1` | OpenCode Go 帳號 1（gateway key 1） |
| `OPENCODE_API_KEY_2` | OpenCode Go 帳號 2（gateway key 2） |
| `OPENCODE_API_KEY_3` | OpenCode Go 帳號 3（gateway key 3） |

改 `apiKeyEnv` 名稱時，**每台機器的 `.credentials.yaml` 要一起改**，
不要只改一邊。

### 5.2 各機狀態

| 機器 | settings `apiKeyEnv` | `.credentials.yaml` 應有 |
|---|---|---|
| Mac | `OPENCODE_API_KEY_1` | `OPENCODE_API_KEY` + `_1` + `_2` |
| mazu/athena/cthulhu/valkyrie（NFS） | `OPENCODE_API_KEY_1` | 同上（共享 home，寫一次） |
| oracle | `OPENCODE_API_KEY_1` | 同上 |
| zeus（swear01 home） | `OPENCODE_API_KEY_1` | 同上 |

### 5.3 檢查命令

```bash
# 每台機器：settings 要的 vs credentials 有的
grep apiKeyEnv ~/.dsh/settings.yaml
grep -o '^[A-Za-z_0-9]*' ~/.dsh/.credentials.yaml
```

### 5.4 端到端驗證（乾淨環境，零 env 變數）

```bash
ssh <host> 'cd /tmp && env -i HOME=$HOME PATH=<node-bin>:/usr/bin:/bin TERM=xterm \
  node "$(which dsh)" --profile headless "Reply with exactly: OK"'
```

預期輸出 `OK`。若出現 `no API key for provider route "deepseek-official"`
→ 就是 5.3 的檢查沒過。

### 5.5 dsh web 是長駐 process

`dsh web` 在啟動時 snapshot 環境與 credentials 檔。**改完
`settings.yaml` / `.credentials.yaml` / `cordis.patch.yml` 後，
正在跑的 `dsh web` 要重啟**，否則繼續用舊狀態（本機 2026-08-16
就發生過 process 早於 config 啟動、一直報錯的情形）。

---

## 6. 改版 Checklist

- [ ] 確認八台清單、正式 executable、supervisor 與 port。
- [ ] 建置四平台 binary，Mac 簽章後記錄 SHA-256。
- [ ] 候選原生 header 測試通過；各機舊版備份及 config hash 已保存。
- [ ] Mac、四台 NFS hosts、Oracle、Zeus、swop 全數安裝並在連線清空後重啟。
- [ ] 八台新程序、binary hash、health、真實推論已驗證，記錄實際 upstream。
- [ ] 各機以該機 config 執行 `check-latest`（需該機 `.secrets`），全部 `ok`。
- [ ] swop 正式與 user-local 副本一致，SYSTEM 排程及憑證保持原樣。
- [ ] 若動到 dsh key 名稱，執行 5.3／5.4 並更新相關 dsh 程序。
- [ ] 清理自己的 staging／worktree；保留已驗證的回復備份。
