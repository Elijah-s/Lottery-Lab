<p align="center">
  <img src="docs/readme-icon.svg" width="112" alt="Lottery Lab README 图标">
</p>

<h1 align="center">Lottery Lab</h1>

Lottery Lab 是一个本地运行的彩票分析实验室，面向「双色球」和「大乐透」场景，提供历史开奖同步、需求化推荐生成、开奖复盘和回测分析等功能。

它不是预测中奖工具，也不提供代购、出票或任何形式的中奖承诺。项目的定位是：把历史数据、规则校验、启发式评分和大模型解释整合到一个桌面应用里，方便做本地化的彩票数据实验。

## 项目特点

- **本地优先**：数据存储在本机，推荐记录、开奖历史和设置都由本地应用管理。
- **支持双色球和大乐透**：内置两种彩票的号码规则、金额计算、历史开奖同步和结果复盘。
- **可生成推荐方案**：输入自然语言需求后，应用会结合历史开奖数据、策略评分和大模型解释生成候选方案。
- **历史开奖可核对**：同步后可查看近期开奖号码，便于确认本地数据是否已经更新。
- **回测与复盘**：支持按历史区间对策略进行回测，并对已生成推荐做开奖命中复盘。
- **大模型可配置**：支持常见兼容接口，密钥仅保存在本机，不在界面明文回显。
- **跨平台安装包**：已提供 Windows x64、macOS Intel、macOS Apple Silicon 对应安装包。

## 下载

当前版本：`v0.1.0`

- [Windows x64 安装包](https://github.com/Elijah-s/Lottery-Lab/releases/download/v0.1.0/Lottery.Lab_0.1.0_x64-setup.exe)
- [macOS Intel 安装包](https://github.com/Elijah-s/Lottery-Lab/releases/download/v0.1.0/Lottery.Lab_0.1.0_x64.dmg)
- [macOS Apple Silicon 安装包](https://github.com/Elijah-s/Lottery-Lab/releases/download/v0.1.0/Lottery.Lab_0.1.0_aarch64.dmg)

完整发布页：  
[https://github.com/Elijah-s/Lottery-Lab/releases/tag/v0.1.0](https://github.com/Elijah-s/Lottery-Lab/releases/tag/v0.1.0)

> 当前安装包未进行 Apple / Microsoft 开发者签名。首次启动时，系统可能会出现安全提示，这是未签名桌面应用的正常表现。

## 适用场景

Lottery Lab 更适合用于：

- 整理和查看双色球、大乐透历史开奖数据
- 基于自定义需求生成一组规则合法的候选号码
- 对生成记录进行复盘和管理
- 对不同策略做历史区间回测
- 研究本地桌面应用中的数据同步、规则评分和大模型解释链路

不适合用于：

- 真实投注决策依据
- 任何形式的保底、必中、提高中奖率承诺
- 代购、出票、资金交易或投注平台接入

## 说明

彩票开奖结果具有随机性。历史热冷、分布区间、重复号、奇偶比等统计特征只能作为数据观察角度，不能推导出确定性结果。

Lottery Lab 的推荐结果仅代表本地规则、历史数据摘要、启发式策略和大模型文本解释的综合输出，不构成投资建议或购彩建议。

## 友情链接

- [LINUX DO](https://linux.do/)
