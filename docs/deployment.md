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
2. 保留各機 config、routing、launcher、憑證與 supervisor 定義；binary-only 更新不得複製範例設定覆蓋它們。
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
保留 SYSTEM principal、BootTrigger、排程 XML、config/routing 與 LocalMachine
DPAPI credentials。不要切換成登入使用者的臨時程序。

1. 先對 Windows 候選 exe 執行隔離的 header 封包測試，核對 hash。
2. 備份正式 exe 與 `%USERPROFILE%\.local\bin\deepseek-gateway.exe` 副本，將候選檔放到各目標旁邊。
3. 確認 port 35001 無 established 連線，停止 `DeepSeek Gateway (SWOP)`。若舊 child 未退出，只停止 executable path 已核對的 Gateway PID。
4. 用 `[IO.File]::Replace` 替換兩份 binary，第三個參數使用明確的備份路徑。Windows PowerShell 可能把 `$null` 轉為空字串，造成 `The path is not of a legal form`。
5. 啟動原排程，確認新 PID、正式 executable path、兩份 binary hash、health，以及設定與排程 XML 未變。失敗則恢復已驗證的備份，再啟動原排程。

## 驗證邊界與最新部署紀錄

2026-09-11 已部署 PR #12 合併提交 `4fa6687`（fix head `f4d7eb3`）至
Mac、四台 NFS、Oracle、Zeus。classifier 把 OpenCode Zen `401 CreditsError` /
`Insufficient balance` 當 quota，同一 request 內 failover，不再把 401 原樣
轉給 Pi/HAPI。47 tests、typecheck、四平台建置通過；七台 Linux/Mac 的磁碟與
`/proc/<pid>/exe`（Mac 為新 PID + 已簽章 binary）SHA-256 吻合，config/routing
未變。真實推論皆 HTTP 200，`X-Gateway-Active-Endpoint: command-code`，
`X-Gateway-Attempt: 4`。這證明 CreditsError 會 latch 到 Command Code，不證明
OpenCode 上游推論成功。

swop 未部署：舊區網 SSH 不通、mDNS 無 `Swear01_PC`、現行 HAPI machine 列表
只有七台且沒有 swop。找到主機前不要把 Windows exe 當成已上線。

先前 2026-09-07 的 PR #10 / `73f0fb5` 八台 session-header rollout 仍是該
契約的基準；本次只換 binary。

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
- [ ] 候選原生 header 測試通過；各機舊版備份及 config/routing hash 已保存。
- [ ] Mac、四台 NFS hosts、Oracle、Zeus、swop 全數安裝並在連線清空後重啟。
- [ ] 八台新程序、binary hash、health、真實推論已驗證，記錄實際 upstream。
- [ ] swop 正式與 user-local 副本一致，SYSTEM 排程及憑證保持原樣。
- [ ] 若動到 dsh key 名稱，執行 5.3／5.4 並更新相關 dsh 程序。
- [ ] 清理自己的 staging／worktree；保留已驗證的回復備份。
