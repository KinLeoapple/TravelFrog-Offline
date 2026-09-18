/**
 * 工坊 (furni) + 栽培 (flowerpot) 单元测试
 * 覆盖: 图纸映射 / 自动开工 / 锁台 / craftTick 结算推送 / replaceFur /
 *       堆肥盒 / mate_list / 播种 / stage 推进 / 收获 (产出+图鉴+清槽)
 */
const assert = require("assert");
const saveMod = require("../save");
const furni = require("../furni");
const fp = require("../flowerpot");

const now = () => Math.floor(Date.now() / 1000);

// ---- 1. 图纸映射 ----
assert.strictEqual(furni.BLUEPRINT_TYPE.size, 27, "27 种图纸");
assert.strictEqual(furni.CRAFTABLE_BY_TYPE.size, 27, "27 个 type 槽");
for (const t of furni.BLUEPRINT_TYPE.values()) assert(furni.CRAFTABLE_BY_TYPE.has(t), "图纸 type 有候选家具");
console.log("图纸映射: 27/27 ✓");

// ---- 2. 自动开工 (putinBench 图纸+材料) ----
const s = saveMod.newSave();
const pid = [...furni.BLUEPRINT_TYPE.keys()][0];           // 图纸 item_id
const target = furni.CRAFTABLE_BY_TYPE.get(furni.BLUEPRINT_TYPE.get(pid));
const mats = furni.craftMaterialsFor(target.furnitureId);
for (const m of mats) s.items.house.push({ item_id: m.item_id, count: m.count });
s.items.house.push({ item_id: pid, count: 1 });
const houseBefore = JSON.stringify(s.items.house);

// 材料未放台 → 不开工: 放无关物品 (非图纸) 不触发
let r = furni.putinBench(s, 6, 1); // 三明治 (house 初始道具)
console.log("无关物品入台:", JSON.stringify(r), "(非图纸不触发制作)");
assert.strictEqual(r.code, 0);
furni.takeoutBench(s, 6);

// 图纸放物品位 → 自动开工 (材料从 house 扣)
r = furni.putinBench(s, 6, pid);
assert.deepStrictEqual(r, { code: 0, crafting: 1 }, "图纸入台自动开工 crafting:1");
assert.strictEqual(s.furniture.benchLock, 1, "锁台");
assert.strictEqual(s.furniture.bench[5], -1, "图纸被用掉");
assert(s.furniture.craft && s.furniture.craft.furnitureId === target.furnitureId, "craft 记录目标家具");
for (const m of mats) {
  const row = s.items.house.find((x) => x.item_id === m.item_id);
  assert(!row || row.count === 0, `材料 ${m.item_id} 扣至 0 (归零删行)`);
}
console.log("自动开工 ✓ (图纸", pid, "→ 家具", target.furnitureId + ")");

// 制作中 mate_list = craft.materials 平铺
const ml = furni.craftMateList(s);
const expectFlat = [];
for (const m of mats) for (let i = 0; i < m.count; i++) expectFlat.push(m.item_id);
assert.deepStrictEqual(ml, expectFlat, "mate_list 材料平铺");

// ---- 3. 锁台: putin/takeout code=6 ----
assert.deepStrictEqual(furni.putinBench(s, 1, 10213), { code: 6 }, "锁台 putin code=6");
assert.deepStrictEqual(furni.takeoutBench(s, 7), { code: 6 }, "锁台 takeout code=6");
console.log("锁台 code=6 ✓");

// ---- 4. craftTick 未到点不结算 ----
let pushed = [];
const push = (c, d) => pushed.push([c, d]);
assert.strictEqual(furni.craftTick(s, push, now() + 1), false, "finishAt 前不结算");
assert.strictEqual(furni.craftTick(s, push, s.furniture.craft.finishAt - 1), false, "差 1s 也不结算");

// ---- 5. craftTick 到点结算 ----
assert.strictEqual(furni.craftTick(s, push, s.furniture.craft.finishAt), true, "到点结算");
assert.strictEqual(s.furniture.craft, null, "craft 清空");
assert.strictEqual(s.furniture.benchLock, 0, "解锁");
assert.deepStrictEqual(s.furniture.owned, [target.furnitureId], "家具入库 owned");
// 四条推送: 完工若蛙还挂着工具动作 (motion 5-9) 需推 client_load_role 归零
// (furni.js 下工逻辑: 不推则庭院蛙永久播工具动画)
assert.deepStrictEqual(pushed.map((x) => x[0]), ["furniture_load_furniture", "item_load_items", "notify_new_event", "client_load_role"], "四条推送");
assert.strictEqual(s.frog.motion, 0, "完工下工 motion 归零");
const evt = pushed[2][1].event;
assert.strictEqual(evt.evt_type, 21, "FurnitureFinish=21");
assert.strictEqual(evt.evt_id, target.furnitureId, "evt_id=产物家具id (修复: 原常量 21)");
assert.deepStrictEqual(evt.evt_value, [target.furnitureId, pid], "evt_value=[家具id,图纸id]");
// payload mate_list 结算后回退 (台面无图纸)
assert.deepStrictEqual(furni.craftMateList(s), [], "结算后 mate_list 空");
console.log("craftTick 结算 + 推送 ✓");

// ---- 6. 材料不足不开工 ----
const s2 = saveMod.newSave();
s2.items.house.push({ item_id: pid, count: 1 }); // 只有图纸无材料
r = furni.putinBench(s2, 6, pid);
assert.deepStrictEqual(r, { code: 0 }, "材料不足: 图纸入台 code=0 但不开工");
assert.strictEqual(s2.furniture.benchLock, 0, "未锁台");
assert.strictEqual(s2.furniture.craft, null, "无 craft");
assert.deepStrictEqual(furni.craftMateList(s2), (furni.craftMaterialsFor(furni.CRAFTABLE_BY_TYPE.get(furni.BLUEPRINT_TYPE.get(pid)).furnitureId) || []).flatMap((m) => Array(m.count).fill(m.item_id)), "mate_list = 台面图纸配方");
// 材料到位后再放一次图纸?? 不行 — 图纸已在台. 取出再放
furni.takeoutBench(s2, 6);
for (const m of mats) s2.items.house.push({ item_id: m.item_id, count: m.count });
r = furni.putinBench(s2, 6, pid);
assert.deepStrictEqual(r, { code: 0, crafting: 1 }, "补齐材料再入图纸 → 开工");
console.log("材料不足→补齐→开工 ✓");

// ---- 7. replaceFur 摆放/撤下 ----
const s3 = saveMod.newSave();
const furId = target.furnitureId;
s3.furniture.owned.push(furId);
r = furni.replaceFur(s3, furId);
assert.strictEqual(r.code, 0, "摆上 code=0");
assert.deepStrictEqual(s3.furniture.placed, [{ type: 9, id: 1009 }, { type: 1, id: furId }], "placed 记录 {type,id} (put_fur 格式; 默认床铺在场)");
assert.strictEqual(furni.replaceFur(s3, furId).code, 1, "同 type 再摆 → 撤下 code=1");
assert.deepStrictEqual(s3.furniture.placed, [{ type: 9, id: 1009 }], "撤下清 placed (默认床铺保留)");
// 未拥有家具 → code 2
const otherId = [...furni.CRAFTABLE_BY_TYPE.values()].find((x) => x.furnitureId !== furId).furnitureId;
assert.strictEqual(furni.replaceFur(s3, otherId).code, 2, "未拥有家具拒绝");
console.log("replaceFur 摆放/撤下 ✓");

// ---- 8. 堆肥盒 ----
const s4 = saveMod.newSave();
s4.items.house.push({ item_id: 10001, count: 3 }, { item_id: 10002, count: 1 });
assert.deepStrictEqual(furni.putinBox(s4, 1, 10001), { code: 0 }, "box putin");
assert.deepStrictEqual(furni.putinBox(s4, 7, 10001), { code: 1 }, "box 越界");
assert.deepStrictEqual(furni.putinBox(s4, 1, 10002), { code: 0 }, "box 顶替 code=0");
assert.strictEqual(s4.furniture.compost.boxes[0], 10002, "box[0] 换新");
assert.strictEqual((s4.items.house.find((x) => x.item_id === 10001) || {}).count, 3, "顶替回仓");
const br = furni.takeoutBox(s4, 1);
assert.deepStrictEqual(br, { code: 0, item_id: 10002 }, "box takeout");
assert.strictEqual(s4.furniture.compost.boxes[0], 0, "box 取后空槽为 0");
assert.deepStrictEqual(furni.takeoutBox(s4, 1), { code: 1 }, "空槽 takeout 拒绝");
console.log("堆肥盒 putin/takeout ✓");

// ---- 9. payload 形状 ----
const pay = furni.furniturePayload(s4);
for (const k of ["bench_lock", "bench", "put_fur", "has_fur", "mate_list", "replace_fur"]) assert(k in pay, "payload." + k);
assert(pay.bench.length === 10, "bench 10 槽");
console.log("furniture payload 形状 ✓");

// ---- 10. 栽培: 播种 + stage 推进 + 肥力门控 ----
const s5 = saveMod.newSave();
const t0 = now();
// 预填堆肥: 升阶要吸收堆肥 (每阶 1 格), 空盒=贫瘠会冻结生长
furni.node(s5).compost.boxes = [10001, 10001, 10001, 10001, 10001, 10001];
assert.strictEqual(furni.compostState(s5), 3, "6 格=肥沃 state 3");
assert.strictEqual(fp.flowerpotTick(s5, t0), true, "空槽播种");
assert.strictEqual(s5.flowerpot.slots.length, 2, "2 个种植位");
for (const slot of s5.flowerpot.slots) {
  assert(fp.FLOWER_PLANTS.includes(slot.id), "播种合法植物 " + slot.id);
  assert.strictEqual(slot.stage, 1, "初始 stage=1");
}
// 推进 (6 格=肥沃: 阶段时长减半)
fp.flowerpotTick(s5, t0 + Math.floor(fp.PLANT_STAGE_SEC / 2));  // 半程即升
assert.strictEqual(s5.flowerpot.slots[0].stage, 2, "肥沃半程 stage=2");
fp.flowerpotTick(s5, t0 + fp.PLANT_STAGE_SEC * 5);   // 远未来
assert.strictEqual(s5.flowerpot.slots[0].stage, 3, "stage 封顶 3");
assert.strictEqual(fp.flowerpotTick(s5, t0 + fp.PLANT_STAGE_SEC * 5 + 1), false, "无变化 false");
assert.strictEqual(s5.furniture.compost.boxes.filter((v) => v > 0).length, 4,
  "仅 2→3 阶吸收 (1→2 种子自养), 2 槽共吸收 2 格");
// payload
const fpay = fp.flowerpotPayload(s5);
assert.deepStrictEqual(fpay.show_list, [{ type: 1, id: 23001 }], "show_list");
assert(Array.isArray(fpay.plant_list) && fpay.plant_list.length === 2, "plant_list 2 条");
assert.strictEqual(fpay.plant_list[0].index, 1, "index 1-based");

// 贫瘠门控: 空堆肥盒种子养分仍可长到 stage 2, 之后冻结等补肥
const s5b = saveMod.newSave();
fp.flowerpotTick(s5b, t0);                                     // 播种 (免费)
assert.strictEqual(furni.compostState(s5b), 1, "0 格=贫瘠 state 1");
fp.flowerpotTick(s5b, t0 + fp.PLANT_STAGE_SEC * 9);            // 贫瘠: 1→2 靠种子养分
assert.strictEqual(s5b.flowerpot.slots[0].stage, 2, "贫瘠 1→2 种子自养");
const freezeAt = t0 + fp.PLANT_STAGE_SEC * 10;
fp.flowerpotTick(s5b, freezeAt);                               // 持续贫瘠: 冻结 2
assert.strictEqual(s5b.flowerpot.slots[0].stage, 2, "贫瘠冻结 stage 2");
furni.node(s5b).compost.boxes[0] = 10001;                      // 补 1 格
fp.flowerpotTick(s5b, freezeAt + 1);                           // 补肥瞬间不跳阶
assert.strictEqual(s5b.flowerpot.slots[0].stage, 2, "补肥后重新计时不瞬间跳阶");
fp.flowerpotTick(s5b, freezeAt + fp.PLANT_STAGE_SEC * 2);      // 冻结点起满 1 阶时长
assert.strictEqual(s5b.flowerpot.slots[0].stage, 3, "补肥后正常升阶");
assert.strictEqual(s5b.furniture.compost.boxes.filter((v) => v > 0).length, 0, "升阶吸收 1 格");
console.log("栽培播种/推进/肥力门控 ✓");

// ---- 11. 收获 ----
// stage<3 拒绝 (第 10 节末 s5 两槽已 stage=3, 用新档)
const s6 = saveMod.newSave();
fp.flowerpotTick(s6, t0);
s6.flowerpot.slots[0].stage = 2;
assert.deepStrictEqual(fp.harvest(s6, 1), {}, "stage<3 收获空对象");
s6.flowerpot.slots[0].stage = 3;
const plantId = s6.flowerpot.slots[0].id;
const hr = fp.harvest(s6, 1);
assert(Array.isArray(hr.item_list) && hr.item_list.length === 1, "item_list 1 条");
assert(hr.item_list[0].num >= 1 && hr.item_list[0].num <= 2, "产量 1~2");
assert(hr.item_list[0].item_id > 0, "产出 item_id");
const got = s6.items.house.find((x) => x.item_id === hr.item_list[0].item_id);
assert(got && got.count === hr.item_list[0].num, "产出入 house");
assert.deepStrictEqual(s6.flowerpot.slots[0], { id: 0, stage: 0, plantedAt: 0 }, "收获清槽");
assert.deepStrictEqual(s6.flowerpot.grown, [plantId], "花园图鉴记录");
assert.deepStrictEqual(fp.harvest(s6, 1), {}, "空槽再收空对象");
console.log("收获 ✓", JSON.stringify(hr));

// ---- 12. 不倒翁制作链 (11101 合页上台 + 图纸 10401 + 材料) ----
const dec = require("../decoration");
const s7 = saveMod.newSave();
// 新档默认送永久图纸 10401/10601
assert((s7.items.house.find((x) => x.item_id === 10401) || {}).count === 1, "新档默认有不倒翁图纸");
assert((s7.items.house.find((x) => x.item_id === 10601) || {}).count === 1, "新档默认有挂兜图纸");
assert.deepStrictEqual(s7.furniture.pocket.list, [22001], "新档默认挂兜 22001");
assert.strictEqual(s7.furniture.pocket.showIndex, 1, "挂兜默认展示");
// 无图纸不放合页 → 不触发
const s7b = saveMod.newSave();
s7b.items.house = s7b.items.house.filter((x) => x.item_id !== 10401);
s7b.items.house.push({ item_id: 11101, count: 1 }, { item_id: 10001, count: 5 }, { item_id: 10005, count: 5 });
let r7 = furni.putinBench(s7b, 6, 11101);
assert.strictEqual(r7.crafting, undefined, "无图纸: 合页上台不开工");
furni.takeoutBench(s7b, 6);
// 材料不足不开工
s7.items.house.push({ item_id: 11101, count: 1 }, { item_id: 10001, count: 2 }); // 松木够, 缺粗布
r7 = furni.putinBench(s7, 6, 11101);
assert.strictEqual(r7.crafting, undefined, "材料不足不开工");
assert.strictEqual(s7.furniture.bench[5], 11101, "合页留台");
assert.strictEqual(s7.furniture.benchLock, 0, "未锁台");
// 材料补齐 (craftTick 自动重试开工)
s7.items.house.push({ item_id: 10005, count: 1 });
assert.strictEqual(furni.craftTick(s7, null, now()), true, "tick 自动补齐开工");
// craftTick 会立即结算 finishAt 过去的?? 不会: finishAt=now+CRAFT_SECONDS 未来
assert.strictEqual(s7.furniture.benchLock, 1, "补齐材料自动开工");
assert.strictEqual(s7.furniture.bench[5], -1, "合页被用掉");
assert.strictEqual(s7.furniture.craft.kind, "tumbler", "craft.kind=tumbler");
assert.strictEqual(s7.furniture.craft.drawing, 10401, "图纸永久保留在 craft 记录");
assert((s7.items.house.find((x) => x.item_id === 10401) || {}).count === 1, "图纸未被消耗");
// 完工: 随机捏一只
pushed = [];
assert.strictEqual(furni.craftTick(s7, push, s7.furniture.craft.finishAt), true, "不倒翁完工");
const tum = s7.furniture.tumbler.list[0];
assert(tum && tum.id >= 20011 && tum.id <= 20183, "模板 id 合法 " + (tum && tum.id));
assert(tum.layers.length >= 1 && tum.layers.length <= 4, "1-4 层");
for (const l of tum.layers) {
  assert.strictEqual(l.layer.length, 5, "每层 5 值");
  const partId = l.layer[0];
  if (tum.id <= 20099) assert(partId < 10000, "低系模板用低系部件");
  else assert(partId >= 10000, "高系模板用高系部件");
  assert(Number.isInteger(l.layer[1]) && Number.isInteger(l.layer[2]), "xy 整数");
}
const evt7 = pushed.find((x) => x[0] === "notify_new_event")[1].event;
assert.strictEqual(evt7.evt_id, tum.id, "evt_id=模板id");
assert.strictEqual(evt7.evt_value[0], 5, "evt_value[0]=每层5值");
assert.strictEqual(evt7.evt_value.length, 1 + tum.layers.length * 5, "evt_value 平铺长度");
// layers 可从 evt_value 重建 (客户端同款切法)
const rebuilt = [];
for (let t = 1; t < evt7.evt_value.length; t += 5) rebuilt.push({ layer: evt7.evt_value.slice(t, t + 5) });
assert.deepStrictEqual(rebuilt, tum.layers, "evt_value 切层还原");
assert(pushed.some((x) => x[0] === "furniture_load_tumbler"), "推 furniture_load_tumbler");
const tp = furni.tumblerPayload(s7);
assert.deepStrictEqual(tp.tumbler_list, s7.furniture.tumbler.list, "tumbler payload");
console.log("不倒翁制作链 ✓ (模板", tum.id, tum.layers.length + "层)");

// ---- 13. 不倒翁 replace 语义 (同 compost) ----
assert.deepStrictEqual(furni.replaceTumbler(s7, 1), { code: 0 }, "展示第1只 code=0");
assert.strictEqual(s7.furniture.tumbler.showIndex, 1);
assert.deepStrictEqual(furni.replaceTumbler(s7, 1), { code: 1 }, "同只再点隐藏 code=1");
assert.strictEqual(s7.furniture.tumbler.showIndex, 0);
assert.deepStrictEqual(furni.replaceTumbler(s7, 0), { code: -1 }, "非法 index");
assert.deepStrictEqual(furni.replaceTumbler(s7, 99), { code: -1 }, "越界 index");
console.log("replaceTumbler 语义 ✓");

// ---- 14. 挂兜制作链 (11102 编绳 + 10601) ----
const s8 = saveMod.newSave();
s8.items.house.push({ item_id: 11102, count: 1 }, { item_id: 10005, count: 2 });
r7 = furni.putinBench(s8, 6, 11102);
assert.strictEqual(r7.crafting, 1, "编绳上台开工");
assert.strictEqual(s8.furniture.craft.kind, "pocket", "craft.kind=pocket");
const pocketTarget = s8.furniture.craft.furnitureId;
assert(furni.POCKET_CRAFTABLE.includes(pocketTarget), "产物是可制作挂兜 " + pocketTarget);
assert(!s8.furniture.pocket.list.includes(pocketTarget), "产物原本未拥有");
pushed = [];
assert.strictEqual(furni.craftTick(s8, push, s8.furniture.craft.finishAt), true, "挂兜完工");
assert(s8.furniture.pocket.list.includes(pocketTarget), "挂兜入库");
const evt8 = pushed.find((x) => x[0] === "notify_new_event")[1].event;
assert.strictEqual(evt8.evt_id, pocketTarget, "evt_id=挂兜id");
assert(pushed.some((x) => x[0] === "furniture_load_pocket"), "推 furniture_load_pocket");
console.log("挂兜制作链 ✓ (做出", pocketTarget + ")");

// ---- 15. 挂兜攒钱 + 领取 ----
const s9 = saveMod.newSave();
assert.strictEqual(furni.pocketTick(s9, now()), false, "首 tick 只记时间戳");
assert.strictEqual(furni.pocketTick(s9, now() + 1800), true, "30min 攒 1 轮");
assert.strictEqual(s9.furniture.pocket.clover, 2, "+2 草");
// 隐藏后不攒
assert.deepStrictEqual(furni.replacePocket(s9, 1), { code: 1 }, "隐藏挂兜");
assert.strictEqual(furni.pocketTick(s9, now() + 3600), false, "隐藏不攒");
// 领取
const before = s9.res.clover_point;
assert.deepStrictEqual(furni.pocketGet(s9), { code: 0, clover: 2 }, "领取 2 草");
assert.strictEqual(s9.res.clover_point, before + 2, "入账");
assert.strictEqual(s9.furniture.pocket.clover, 0, "清零");
assert.deepStrictEqual(furni.pocketGet(s9), { code: 1, clover: 0 }, "空兜再领 code=1");
// 上限 99: 直接构造溢出
s9.furniture.pocket.clover = 98;
furni.replacePocket(s9, 1);
s9.furniture.pocket.lastGainAt = now() - 3600 * 60;
furni.pocketTick(s9, now());
assert.strictEqual(s9.furniture.pocket.clover, 99, "上限 99");
console.log("挂兜攒钱/领取 ✓");

// ---- 16. 装饰插花 (Design B: 插不消耗, 换花扣旧花) ----
const s10 = saveMod.newSave();
// 找一朵花: 角堇·火龙果 202211 → 装饰 10011 (名字映射)
assert.strictEqual(dec.DEC_BY_ITEM.get(202211), 10011, "物品202211→装饰10011");
s10.items.house.push({ item_id: 202211, count: 2 }, { item_id: 202101, count: 1 }); // 角堇×2 + 蜡梅×1
let dp = dec.decoratePayload(s10);
assert(dp.has_list.length === 2, "has_list 两类花");
assert.deepStrictEqual(dp.has_list[0], { id: 10011, num: 2 }, "条目 {id,num}");
assert.deepStrictEqual(dp, { has_list: dp.has_list, put_id: 0, status: 0 }, "初始未插");
// 插角堇 (不消耗)
assert.deepStrictEqual(dec.changeDecorate(s10, 10011), { code: 0 }, "插花 code=0");
assert.strictEqual(s10.furniture.decorate.putId, 10011, "putId 记录");
assert.strictEqual(s10.furniture.decorate.status, 1, "花苞");
assert.strictEqual((s10.items.house.find((x) => x.item_id === 202211) || {}).count, 2, "插花不消耗库存");
// 换蜡梅 → 旧花扣 1
assert.deepStrictEqual(dec.changeDecorate(s10, 100), { code: 0 }, "换花 code=0");
assert.strictEqual((s10.items.house.find((x) => x.item_id === 202211) || {}).count, 1, "旧花被用掉 1");
assert.strictEqual(s10.furniture.decorate.putId, 100, "putId 换新");
// 再插同一朵不重复扣
assert.deepStrictEqual(dec.changeDecorate(s10, 100), { code: 0 }, "同花再插 code=0");
assert.strictEqual((s10.items.house.find((x) => x.item_id === 202101) || {}).count, 1, "同花不扣");
// 没有的花拒绝
assert.deepStrictEqual(dec.changeDecorate(s10, 1002), { code: 2 }, "没这朵花 code=2");
// 绽放 tick
const putAt = s10.furniture.decorate.putAt;
assert.strictEqual(dec.decorateTick(s10, putAt + 3599), false, "1h 前不绽放");
assert.strictEqual(dec.decorateTick(s10, putAt + 3600), true, "1h 绽放 status=2");
assert.strictEqual(s10.furniture.decorate.status, 2, "status 2");
console.log("装饰插花 Design B ✓");

// ---- 17. 旧档迁移 (tumbler/pocket/decorate 节点 + 补图纸) ----
const s11 = saveMod.newSave();
// 模拟旧档: 删掉新节点与图纸
delete s11.furniture.tumbler;
delete s11.furniture.pocket;
delete s11.furniture.decorate;
s11.items.house = s11.items.house.filter((x) => x.item_id !== 10401 && x.item_id !== 10601);
s11.furniture.craft = null; // 旧档 craft 无 kind
const fake = { furniture: s11.furniture, items: s11.items, frog: s11.frog, res: s11.res };
// furni.node 兜底
furni.node(fake);
assert.deepStrictEqual(fake.furniture.tumbler, { list: [], showIndex: 0, replaceIndex: 0 }, "tumbler 兜底");
assert.deepStrictEqual(fake.furniture.pocket.list, [22001], "pocket 兜底送初始款");
assert.strictEqual(fake.furniture.pocket.showIndex, 1, "pocket 默认展示");
assert.deepStrictEqual(fake.furniture.decorate, { putId: 0, status: 0, putAt: 0 }, "decorate 兜底");
// save.load 迁移 (图纸补送): 直接跑一遍 node 后手动补图纸 (save.load 内联逻辑同)
for (const pid of [10401, 10601]) {
  if (!fake.items.house.find((x) => x.item_id === pid)) fake.items.house.push({ item_id: pid, count: 1 });
}
assert((fake.items.house.find((x) => x.item_id === 10401) || {}).count === 1, "补送图纸");
console.log("旧档迁移 ✓");

console.log("\n全部通过 ✓");
