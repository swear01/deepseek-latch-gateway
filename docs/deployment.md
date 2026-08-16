# 部署指南（Deployment & Rollout）

本文件是 gateway 改版 + fleet rollout + dsh（DeepSeek Harness）credentials
同步的**操作手冊**。2026-08-16 的兩次事故（fleet 跑舊 binary 數小時、
dsh key 名稱 mismatch）就是沒有照本文件執行造成的，改版後請逐項照做。

---

## 1. 版本發布流程

```bash
# 在 main checkout（乾淨、已 pull）
git checkout main && git pull --ff-only
bun run build:all        # 產生 dist/deepseek-gateway(-linux-x64/-linux-arm64)
```

| binary | 用途 |
|---|---|
| `dist/deepseek-gateway` | Mac（arm64），LaunchAgent 用 |
| `dist/deepseek-gateway-linux-x64` | mazu / athena / cthulhu / valkyrie（NFS 共享） |
| `dist/deepseek-gateway-linux-arm64` | oracle（aarch64） |

> **只 build 不部署 = 沒有發布。** code 進 main 之後，三種 binary 都要
> 部署到對應機器，缺一台就是一台舊版。

---

## 2. Fleet 機器一覽

| 機器 | arch | binary 路徑 | 服務 | 備註 |
|---|---|---|---|---|
| Mac | arm64 | `~/.local/bin/deepseek-gateway` | LaunchAgent `com.swear.deepseek-gateway` | 唯一走 LaunchAgent |
| mazu / athena / cthulhu / valkyrie | x86_64 | `~/.local/bin/deepseek-gateway`（**NFS 共享同一個檔案**） | `systemctl --user deepseek-gateway` | 寫一次檔案，但**每台各自 restart** |
| oracle | aarch64 | `~/.local/bin/deepseek-gateway` | `systemctl --user deepseek-gateway` | 獨立 home |
| zeus（swear02） | — | 由 swear02 帳號管理 | — | swear01 在 zeus 不部署 gateway（zeus 屬 swear02） |

---

## 3. Mac 部署（LaunchAgent）

```bash
cp dist/deepseek-gateway ~/.local/bin/deepseek-gateway
launchctl kickstart -k gui/$(id -u)/com.swear.deepseek-gateway
sleep 2
curl -s http://127.0.0.1:35001/healthz
```

---

## 4. Linux fleet 部署（systemd user unit）

### 4.1 傳檔（注意 NFS gotcha）

**NFS 上 scp 直接覆寫目標檔案會失敗**（`dest open ... Failure`）。
一律先傳 `/tmp` 再 `mv`：

```bash
scp dist/deepseek-gateway-linux-x64   mazu:/tmp/gw-new
scp dist/deepseek-gateway-linux-arm64 oracle:/tmp/gw-new

ssh mazu   'mv /tmp/gw-new ~/.local/bin/deepseek-gateway'    # NFS 共享 → 四台同檔
ssh oracle 'mv /tmp/gw-new ~/.local/bin/deepseek-gateway'
```

### 4.2 重啟（每台都要做）

NFS 共享的是**檔案**，不是 process — mazu 寫檔後 athena/cthulhu/valkyrie
還是舊 code，必須每台各自 restart：

```bash
for h in mazu athena cthulhu valkyrie oracle; do
  ssh "$h" 'chmod +x ~/.local/bin/deepseek-gateway && systemctl --user restart deepseek-gateway'
done
```

### 4.3 驗證（全部機器）

```bash
for h in mazu athena cthulhu valkyrie oracle; do
  echo "== $h"
  ssh "$h" 'md5sum ~/.local/bin/deepseek-gateway; systemctl --user is-active deepseek-gateway; curl -s -m 3 http://127.0.0.1:35001/healthz'
done
```

預期：五台的 md5 都是本地 `md5 -q dist/deepseek-gateway-linux-*` 的對應值，
service `active`，healthz `status: ok`。

> **重啟後 latch 歸零是正常現象**：`active_index` 回到 0（key 1），
> 第一筆真實 429 會再翻到 key 2。不是 bug。

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

## 6. 改版 Checklist（照抄用）

- [ ] `git pull --ff-only` + `bun run build:all`
- [ ] Mac：`cp dist/deepseek-gateway ~/.local/bin/` + `launchctl kickstart -k`
- [ ] fleet：scp 到 `/tmp` → `mv`（**不要直接 scp 覆寫 NFS 檔**）
- [ ] fleet：五台各自 `systemctl --user restart deepseek-gateway`
- [ ] fleet：五台 md5 / healthz 驗證
- [ ] 若動到 dsh key 名稱：5.3 檢查 + 5.4 乾淨環境實測 + 重啟 `dsh web`
- [ ] 確認 `/status` 的 `totalSwitches` / `lastSwitchReason` 符合預期
