---
name: validate-evaluator
description: 用数据切分、TPR/TNR 和偏差校准，把 LLM judge 校准到人工标注水平。在写好 judge 提示词（`write-judge-prompt`）之后、信任其输出之前使用，验证它与人类判断对齐。代码评测器不适用（那些是确定性的，按 `write-code-eval` 用单元测试测）。
---

# 校验评测器

用人工判断校准 LLM judge。

## 概览

1. 把人工标注数据切成 train（10-20%）、dev（40-45%）、test（40-45%）
2. 在 dev 集上跑 judge，测 TPR/TNR
3. 迭代改进 judge，直到 dev 集 TPR、TNR 都超过 90%
4. 在留出的 test 集上跑一次，得最终 TPR/TNR
5. 用偏差校正公式修正生产数据的通过率

## 前置条件

- 已写好的 LLM judge 提示词（来自 `write-judge-prompt`）
- 人工标注数据：每个失败模式约 100 条带二元 Pass/Fail 标签的 trace
  - 目标约 50 Pass、50 Fail（保持均衡，哪怕真实分布偏斜）
  - 标注必须来自领域专家，不能外包给众包标注
- 从标注数据里选出的候选 few-shot 示例

## 核心步骤

### 第 1 步：切分数据

把人工标注数据切成三个互不重叠的集合：

| 集合 | 占比 | 用途 | 规则 |
|---|---|---|---|
| **Training** | 10-20%（约 10-20 条） | judge 提示词的 few-shot 示例来源 | 只放边界清晰的 Pass 和 Fail。直接进提示词。 |
| **Dev** | 40-45%（约 40-45 条） | 迭代打磨评测器 | 绝不进提示词。反复用它评估。 |
| **Test** | 40-45%（约 40-45 条） | 最终无偏准确率 | 开发期间不看。最后只用一次。 |

目标：dev 与 test 合计每类 30-50 条（Pass 和 Fail）。哪怕真实占比偏斜也保持均衡切分——Fail 样例不够，TNR 就测不稳。

```python
from sklearn.model_selection import train_test_split

# 第一次切分：先分离 test 集
train_dev, test = train_test_split(
    labeled_data, test_size=0.4, stratify=labeled_data['label'], random_state=42
)
# 第二次切分：从剩余数据中分离 training 示例与 dev 集
train, dev = train_test_split(
    train_dev, test_size=0.75, stratify=train_dev['label'], random_state=42
)
# 结果：约 15% train、45% dev、40% test
```

### 第 2 步：在 dev 集上跑评测器

对 dev 集每条样例跑 judge，把预测与人工标签比对。

### 第 3 步：测 TPR 和 TNR

**TPR（真阳性率）**：人工说 Pass 时，judge 也说 Pass 的比例。

```
TPR = (judge 说 Pass 且人工说 Pass) / (人工说 Pass)
```

**TNR（真阴性率）**：人工说 Fail 时，judge 也说 Fail 的比例。

```
TNR = (judge 说 Fail 且人工说 Fail) / (人工说 Fail)
```

```python
from sklearn.metrics import confusion_matrix

tn, fp, fn, tp = confusion_matrix(human_labels, evaluator_labels,
                                   labels=['Fail', 'Pass']).ravel()
tpr = tp / (tp + fn)
tnr = tn / (tn + fp)
```

用 TPR/TNR，不用 Precision/Recall 或裸准确率：这两个指标直接进偏差校正公式。Cohen's Kappa 只用于测两个标注人之间的一致性，不用于 judge 对真值。

### 第 4 步：逐条审查分歧

检查 judge 与人工标签不一致的每一处：

| 分歧类型 | judge | 人工 | 修法 |
|---|---|---|---|
| **假 Pass** | Pass | Fail | judge 太宽松。收紧 Fail 定义，或补边界情形示例。 |
| **假 Fail** | Fail | Pass | judge 太严。澄清 Pass 定义，或调整示例。 |

对每处分歧决定采取哪种手段：

- 澄清 judge 提示词的措辞
- 从 training set 换掉或补充 few-shot 示例
- 给边界情形加显式规则
- 把判定标准拆成更小的子检查

### 第 5 步：迭代

改 judge 提示词，在 dev 集重跑，直到 TPR 和 TNR 稳定。

**停止条件：**
- **目标**：TPR > 90% 且 TNR > 90%
- **可接受下限**：TPR > 80% 且 TNR > 80%

**对齐停滞时：**

| 问题 | 对策 |
|---|---|
| TPR、TNR 都低 | 给 judge 换更强的 LLM |
| 一项低、另一项可接受 | 专查拖低那一项的分歧样例 |
| 两项都停在目标之下 | 把判定标准拆成更小、更原子的检查 |
| 某类输入一直判错 | 从 training set 补针对性的 few-shot 示例 |
| 标签本身就互相矛盾 | 回查人工标注；评判标准可能需要打磨 |

### 第 6 步：test 集终测

在留出的 test 集上只跑一次。记录最终 TPR 和 TNR。

看过 test 结果后不再迭代。需要继续改，回第 4 步并换新的 dev 数据。

### 第 7 步（可选）：估计真实成功率（Rogan-Gladen 校正）

未标注生产数据上的原始 judge 通过率有偏。需要准确的总体通过率时，用已知的 judge 错误率校正：

```
theta_hat = (p_obs + TNR - 1) / (TPR + TNR - 1)
```

其中：

- `p_obs` = judge 判为 Pass 的未标注 trace 占比
- `TPR`、`TNR` = test 集终测值
- `theta_hat` = 校正后的真实成功率估计

结果截断到 [0, 1]。TPR + TNR - 1 接近 0 时无效（judge 不比随机强）。

**例子：**
- judge TPR = 0.92，TNR = 0.88
- 500 条生产 trace 中 400 条判 Pass → p_obs = 0.80
- theta_hat = (0.80 + 0.88 - 1) / (0.92 + 0.88 - 1) = 0.68 / 0.80 = **0.85**
- 真实成功率约 85%，不是原始的 80%

### 第 8 步：置信区间

算 bootstrap 置信区间。只有点估计不够。

```python
import numpy as np

def bootstrap_ci(human_labels, eval_labels, p_obs, n_bootstrap=2000):
    """校正成功率的 bootstrap 95% 置信区间。"""
    n = len(human_labels)
    estimates = []
    for _ in range(n_bootstrap):
        idx = np.random.choice(n, size=n, replace=True)
        h = np.array(human_labels)[idx]
        e = np.array(eval_labels)[idx]

        tp = ((h == 'Pass') & (e == 'Pass')).sum()
        fn = ((h == 'Pass') & (e == 'Fail')).sum()
        tn = ((h == 'Fail') & (e == 'Fail')).sum()
        fp = ((h == 'Fail') & (e == 'Pass')).sum()

        tpr_b = tp / (tp + fn) if (tp + fn) > 0 else 0
        tnr_b = tn / (tn + fp) if (tn + fp) > 0 else 0
        denom = tpr_b + tnr_b - 1

        if abs(denom) < 1e-6:
            continue
        theta = (p_obs + tnr_b - 1) / denom
        estimates.append(np.clip(theta, 0, 1))

    return np.percentile(estimates, 2.5), np.percentile(estimates, 97.5)

lower, upper = bootstrap_ci(test_human, test_eval, p_obs=0.80)
print(f"95% CI: [{lower:.2f}, {upper:.2f}]")
```

或直接用 `judgy`（`pip install judgy`）：

```python
from judgy import estimate_success_rate

# judgy 期望 0/1 整数标签（1 = Pass，0 = Fail）
test_labels = [1 if l == 'Pass' else 0 for l in test_human_labels]
test_preds = [1 if l == 'Pass' else 0 for l in test_eval_labels]
unlabeled_preds = [1 if l == 'Pass' else 0 for l in prod_eval_labels]

theta_hat, lower, upper = estimate_success_rate(
    test_labels, test_preds, unlabeled_preds
)
print(f"校正后比率: {theta_hat:.2f}")
print(f"95% CI: [{lower:.2f}, {upper:.2f}]")
```

## 实操要点

- **钉死确切模型版本**（形如 `<model>-<YYYY-MM-DD>` 的快照 id，不用浮动别名）。供应商会不声不响更新模型，造成静默漂移。
- 改了 judge 提示词、换了模型、或生产置信区间意外变宽时，**重新校验**。
- 标注样例约 100 条（50 Pass、50 Fail）；低于 60 条，置信区间明显变宽。
- **一位可信的领域专家**是最高效的标注路径。做不到，就两个标注人独立标 20-50 条，分歧解决后再继续。
- **提高 TPR 比提高 TNR 更能收窄置信区间。** 校正公式除以 `(TPR + TNR - 1)`，TPR 低会缩小分母，把估计误差放大成宽区间。

## 反模式

- **默认「judge 开箱即用」。** judge 可能一直漏报失败，或把通过的判成失败。
- **报裸准确率或一致百分比。** 类别不均衡时裸准确率有误导性，用 TPR 和 TNR。
- **拿 dev/test 样例当 few-shot。** 这是数据泄漏。
- **把 dev 集成绩当最终准确率报。** dev 数字偏乐观，test 集才给无偏估计。
- **不校正偏差就报原始 judge 分数。** 报总体通过率必须套 Rogan-Gladen 公式（第 7 步）。
- **只报点估计不给置信区间。** 小 test 集下「85%」实际可能是 78-92%。报区间，读的人才知道这个数能信多少。
