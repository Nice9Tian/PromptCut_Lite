# Lite 版怎么来的

Lite 由 `lite/generate.mjs` 从 [PromptCut_Community](https://github.com/Nice9Tian/PromptCut_Community) 生成。
仓库根下除了 `lite/` 都是生成结果，**别手改**，CI 会核对。

| 文件 | 是什么 |
|---|---|
| `base.txt` | 配方对应的社区版提交 |
| `cut.txt` | 从社区版裁掉的路径 |
| `patches/` | Lite 改过的文件，一个文件一份补丁 |
| `files/` | 社区版没有、Lite 自己的文件 |

## 跟上社区版

```bash
node lite/generate.mjs
```

它把工作区换成社区版最新提交的生成结果，并更新配方，不提交。跑完测试再提交：

```bash
npm test
git add -A
git commit
```

社区版改了 Lite 也改过的地方时，脚本列出合不上的文件，冲突标记留在工作区。改好之后：

```bash
node lite/generate.mjs --record <脚本打印的提交>
```

社区版新加的文件默认留下。Lite 不要的写进 `cut.txt`，或者在工作区删掉再 `--record`。

## 改 Lite 自己的东西

在工作区改完，用当前基准记一次：

```bash
node lite/generate.mjs --record "$(cat lite/base.txt)"
```

这里只放 Lite 才有的差异。别的改动去社区版提，再生成过来。

## 核对

```bash
node lite/generate.mjs --check
```

检查提交的内容和配方生成的结果一字不差。
