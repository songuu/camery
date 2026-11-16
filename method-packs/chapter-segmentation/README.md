# chapter-segmentation 1.0.0

自写章节切分方法。运行资产按 pack.yaml 明确列出，不执行来源中的指令、脚本或远程 schema。pack.yaml 使用严格 JSON（YAML 1.2 的子集），暂不接受 YAML 标签、别名或其他 YAML 写法。

instructions.md、rules、examples、cards、evals 全部内容进入方法 pin 摘要。黄金基线另存 evals/baseline.json，包含采用该基线时的方法包、实际输出、工具轨迹和评分记录；基线文件不反过来进入自身摘要。

```sh
pnpm test:methods:evals
```

默认只比较已存基线，不自动更新。维护者需要更改基线时，先检查方法版本、用例及来源，再显式执行 `pnpm --filter @camery/methods eval:check --write-baseline` 并审查差异；不能用重写基线掩盖退步。

黄金集包括三类素材及六个确定性用例：公有领域中文小说《老殘遊記》开头节选、古典《西遊記》开头节选、自写三集《停下的钟》，另有 CRLF、BOM 和无显式标题变体。它们验证切片、标题、原文摘要、结构、离线工具过程及边界 F1；不是整部小说、10 章长文本验收、LLM 艺术评分或人工审片。

## 来源及许可

摘录与变更说明见 [evals/corpus.json](evals/corpus.json)，pack.yaml 的 provenance 保存固定页面版本和许可。章回与回目合并为一行，选取每回开头短句，统一 LF；保留繁体和所选原句标点，没有复制现代改写版本或网站导航。

- 《老殘遊記》署名劉鶚，使用维基文库 [第一回 oldid 2367222](https://zh.wikisource.org/w/index.php?title=%E8%80%81%E6%AE%98%E9%81%8A%E8%A8%98%2F%E7%AC%AC01%E5%9B%9E&oldid=2367222)、[第二回 oldid 2367223](https://zh.wikisource.org/w/index.php?title=%E8%80%81%E6%AE%98%E9%81%8A%E8%A8%98%2F%E7%AC%AC02%E5%9B%9E&oldid=2367223)。[作者页 oldid 2631118](https://zh.wikisource.org/w/index.php?title=Author%3A%E5%8A%89%E9%B6%9A_%28%E6%B8%85%29&oldid=2631118) 有原作公有领域说明。
- 《西遊記》按来源署名吳承恩，使用维基文库 [第一回 oldid 2562136](https://zh.wikisource.org/w/index.php?title=%E8%A5%BF%E9%81%8A%E8%A8%98%2F%E7%AC%AC001%E5%9B%9E&oldid=2562136)、[第二回 oldid 2449088](https://zh.wikisource.org/w/index.php?title=%E8%A5%BF%E9%81%8A%E8%A8%98%2F%E7%AC%AC002%E5%9B%9E&oldid=2449088)。[作者页 oldid 2620558](https://zh.wikisource.org/w/index.php?title=Author%3A%E5%90%B3%E6%89%BF%E6%81%A9&oldid=2620558) 有原作公有领域说明。
- 上述维基文库页面标注 [CC BY-SA 4.0](https://creativecommons.org/licenses/by-sa/4.0/)。本目录中采用的转录摘录及相关来源元数据保留该许可、署名和固定链接；这不把相同许可扩展到独立编写的程序代码。
- 《停下的钟》是本任务自写的合成测试素材，含来源指令注入和引号内假标题，未使用客户素材；不能当成客户授权样本。

这些是本次选材与来源记录，不替代 T0.11 的产品合规预审或法律规则核实。
