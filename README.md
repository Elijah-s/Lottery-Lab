<p align="center">
  <img src="docs/readme-icon.svg" width="112" alt="Lottery Lab README 图标">
</p>

<h1 align="center">Lottery Lab</h1>

Lottery Lab 是一个本地运行的彩票数据实验室，面向双色球、大乐透和世界杯赛事分析场景，整合历史数据同步、自然语言需求解析、本地规则校验、候选方案评分、大模型解释、开奖复盘、历史回测、赛事情报整理和预算模拟等能力。

项目的目标不是预测中奖，也不提供代购、出票、开户链接或任何中奖承诺。它更适合用于把公开数据、规则约束、历史样本、复盘反馈和 LLM 分析组织到同一个本地应用里，做可追溯的彩票数据实验。

## 当前能力

### 双色球与大乐透

- 历史开奖同步：支持双色球和大乐透开奖数据同步，可自定义拉取期数，并在官方源不可用时使用备用源补齐。
- 最新开奖预览：同步后展示近期开奖号码，便于核对本地数据是否可信、是否已更新。
- 自然语言推荐：输入如“双色球 20 元 最近 50 期 稳一点”这类需求，系统会解析彩种、预算、玩法、追加、风险偏好和历史分析窗口。
- LLM 参与选号：本地先生成合法候选池和历史统计摘要，再交给配置的大模型选择候选、解释依据并给出风险提示。
- 历史窗口可控：未指定时默认分析 200 期；明确写出“最近 50 期”“根据 500 期数据”时，会按用户指定期数参与取数、评分和 LLM 提示。
- 推荐复盘反馈：已生成推荐会在开奖后复盘命中情况，后续推荐会把历史复盘表现作为弱信号纳入提示词。
- 历史管理：支持查看、删除单条推荐记录，也支持批量删除。
- 回测分析：支持在历史期号区间内对多个策略做回测，对比主奖命中、副奖命中、平均评分和样本表现。
- 导出结果：回测记录支持 JSON 和 CSV 导出。

### 世界杯模块

- 赛程同步：支持同步世界杯赛程，按队伍、阶段、城市或场次筛选。
- 中文队名展示：赛事列表和详情页使用中文队名，方便快速阅读。
- 赛前情报：可针对单场比赛获取赛前情报，记录来源、可信度、审查状态和时间。
- 多模型配置：赛前情报、比赛模拟、预算模拟可分别使用独立的 LLM 服务商、接口地址、模型和密钥，也可沿用通用配置。
- 比赛模拟：在赛前情报通过审查后，结合赛程、队伍、情报、赔率状态和风险边界生成中文分析。
- 预算模拟：根据预算、风险偏好和可验证赔率状态生成预算说明；官方赔率不足时会降级为分析模式，避免编造投注规划。
- 数据源队列：提供赛程源、体彩源、备用源健康检查和任务状态展示。

### 设置与提示词

- 通用 LLM 设置：支持 OpenAI Compatible、OpenAI、DeepSeek、OpenRouter、本地模型服务和自定义服务商。
- 模型获取与连接测试：可从配置的接口拉取模型列表，也可测试当前配置是否可用。
- 密钥本地保存：API Key 只保存在本机，界面不明文回显。
- 独立场景配置：世界杯情报、预测、预算可以分别配置模型，避免所有任务绑定同一个模型。
- 提示词编辑：内置彩票专家、数学专家、建模师等角色提示词，支持在应用中调整并保存。

## 平台支持

Lottery Lab 基于 Tauri 2、React、TypeScript、Rust 和 SQLite 构建。

- macOS Apple Silicon
- macOS Intel
- Windows x64
- Android APK 本地构建

当前版本：`v0.2.1`

桌面安装包可在发布页下载：

- [Windows x64 安装包](https://github.com/Elijah-s/Lottery-Lab/releases/download/v0.2.1/Lottery.Lab_0.2.1_x64-setup.exe)
- [macOS Intel 安装包](https://github.com/Elijah-s/Lottery-Lab/releases/download/v0.2.1/Lottery.Lab_0.2.1_x64.dmg)
- [macOS Apple Silicon 安装包](https://github.com/Elijah-s/Lottery-Lab/releases/download/v0.2.1/Lottery.Lab_0.2.1_aarch64.dmg)

完整发布页：[https://github.com/Elijah-s/Lottery-Lab/releases](https://github.com/Elijah-s/Lottery-Lab/releases)

> 当前安装包未进行 Apple / Microsoft 开发者签名。首次启动或安装时，系统可能会出现安全提示。

## 本地运行

```bash
npm install
npm run dev
```

桌面构建：

```bash
npm run build
npm run package:mac:arm
npm run package:mac:intel
npm run package:windows
```

Android 构建：

```bash
npm run android:init
npm run android:build:debug:arm64
```

常用检查：

```bash
npm run typecheck
npm test -- --run
```

## 数据与风险说明

彩票开奖结果具有随机性。历史热冷、分布区间、奇偶比、重号、遗漏、赛事状态、赔率变化和模型输出都只能作为观察角度，不能推导出确定性结果。

Lottery Lab 的推荐、回测、复盘、世界杯模拟和预算模拟均为本地实验结果，不构成投资建议、购彩建议或投注指令。使用前应自行核验官方开奖、赛程和赔率信息。

## 友情链接

- [LINUX DO](https://linux.do/)
