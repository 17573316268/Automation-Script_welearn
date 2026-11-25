// ==UserScript==
// @name         WE Learn 自动刷课（自动完成开放练习）
// @namespace    welearn-auto-brush
// @version      2.9.33
// @description  哄尖尖老师专用：自动检索 WE Learn 各单元已开放（黑色字体）练习，跳过已完成（绿色对勾/有分数），从第一个未完成练习开始按顺序作答（选词填空、段落匹配、划线词辨析、复合词填空），提交后点右下角「下节」继续，无下节则回目录进入下一节/下一单元。v2.9 增强段落匹配：自动展开文章、识别「?」淡蓝空盒、底部 Para 选项栏按题对齐后逐项点击填入、全部填完自动提交。v2.9.23 段落匹配修复：允许同一段落被多条陈述选用、点选项前先确认选项栏确实停在本条陈述上、每点一下立即回读状态判定。v2.9.24 新增「划线词词义辨析选择题」自动作答。v2.9.25 划线词辨析修复：选项改为字母锚点解析、题块自动识别、点击优先取选项文字节点、修正选中态的对象引用比较。v2.9.26 修复多题只答 1 题。v2.9.27 修复整卡被单个容器包裹时只认成 1 题。v2.9.28 新增「复合词构词法填空」。v2.9.29 修复题型误判：划线词辨析不再把选词填空认成自己——不再因祖先元素带下划线就判定划线、纯数字（如 500）不再算划线词，并要求真的存在"含一整组 A/B/C/D 且不含输入框"的选择题组才判定为划线词辨析题型。
// @match        *://welearn.sflep.com/*
// @match        *://*.sflep.com/*
// @grant        GM_xmlhttpRequest
// @connect      api.deepseek.com
// @connect      *
// @run-at       document-idle
// @noframes
// ==/UserScript==

(function () {
    'use strict';

    // 只在顶层框架运行（篡改猴默认会注入 iframe，导致练习页出现两个面板、两个实例互相干扰）
    if (window.top !== window.self) return;

    const VERSION = 'v2.9.33';

    /* ===================== 配置区 ===================== */
    const CFG = {
        coursePagePattern: /course_info/i,
        unitTitleSelector: '[class*="unit"], .unitTitle, h3, h4',
        lockedClassKeywords: ['lock', 'disable', 'notopen', 'unopen', 'gray', 'grey', 'closed'],
        grayColorThreshold: 140,
        submitTexts: ['submit', '提交'],
        stepDelay: 1500,
        pageSettleDelay: 2500,
        llmTimeout: 60000,
        optionBarDelay: 900,
        // 练习页等待题目加载的重试次数与间隔
        contentWaitRounds: 8,
        contentWaitInterval: 2000,
    };

    const PROVIDERS = {
        deepseek: { baseURL: 'https://api.deepseek.com', defaultModel: 'deepseek-flash', models: ['deepseek-flash', 'deepseek-v4-pro'] },
        openai:   { baseURL: 'https://api.openai.com',   defaultModel: 'gpt-4o-mini',    models: ['gpt-4o-mini', 'gpt-4o'] },
        custom:   { baseURL: '',                          defaultModel: '',               models: [] },
    };

    const STATE_KEY = 'welearn_auto_state';
    const LLM_KEY = 'welearn_llm_config';
    const BLANK_ATTR = 'data-weauto-blank'; // 黄空标记属性名
    const PARA_BADGE_ATTR = 'data-weauto-para-badge'; // 文章段落标记（避免与选项区的 Para 按钮混淆）

    // 段落匹配最近一次的分配结果（提交后"还有N题未完成"的自动补选要用）
    let lastMatchPlan = null;
    // 划线词辨析最近一次的答案计划（题号 → 字母），提交被拒时补选要用
    const underlinePlan = new Map();


    /* ===================== 强制停止 ===================== */
    // 内存级停止标志：点「停止」后当前异步流程在下一个检查点立即中止，
    // 不再提交、不再跳节；localStorage.running 同时置 false，新页面不会自动续跑
    let STOP_FLAG = false;
    const isStopped = () => STOP_FLAG || !loadState().running;

    /* ===================== 状态管理 ===================== */
    function loadState() {
        try { return JSON.parse(localStorage.getItem(STATE_KEY)) || {}; }
        catch (e) { return {}; }
    }
    function saveState(s) { localStorage.setItem(STATE_KEY, JSON.stringify(s)); }
    function loadLLMConfig() {
        try { return JSON.parse(localStorage.getItem(LLM_KEY)) || null; }
        catch (e) { return null; }
    }
    function saveLLMConfig(c) { localStorage.setItem(LLM_KEY, JSON.stringify(c)); }

    /* ===================== 日志（统一写入控制面板的日志区） ===================== */
    // 停止后所有 sleep 立即抛出"已停止"异常，unwind 整个异步答题链，实现点停止即全停
    const sleep = (ms) => new Promise((res, rej) => setTimeout(() => {
        if (STOP_FLAG) rej(Object.assign(new Error('已停止'), { stopped: true }));
        else res();
    }, ms));
    // 顶层捕获：停止异常静默吞掉，其它错误打印
    const guard = (p) => Promise.resolve(p).catch(e => { if (!(e && e.stopped)) console.error('[WEAuto]', e); });

    const log = (...args) => {
        console.log('[WEAuto]', ...args);
        const line_text = `[${new Date().toLocaleTimeString()}] ${args.join(' ')}`;
        const box = document.getElementById('weauto-log');
        if (box) {
            const line = document.createElement('div');
            line.textContent = line_text;
            box.appendChild(line);
            box.scrollTop = box.scrollHeight;
        }
    };
    const textOf = (el) => (el ? (el.innerText || el.textContent || '').trim() : '');

    // 模拟真实鼠标点击（完整事件序列，兼容性远好于 el.click()）
    function realClick(el) {
        if (!el) return;
        const view = el.ownerDocument.defaultView || window;
        ['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click'].forEach(type => {
            const Ev = (type.startsWith('pointer') && view.PointerEvent) ? view.PointerEvent : view.MouseEvent;
            el.dispatchEvent(new Ev(type, { bubbles: true, cancelable: true, view }));
        });
    }

    window.alert = (m) => log('alert已自动关闭:', m);
    window.confirm = () => true;

    // 原生写入值（input/textarea 通用，触发 input/change），异常时退回直接赋值
    function setNativeValue(el, text) {
        try {
            const win = el.ownerDocument.defaultView;
            const proto = el.tagName === 'TEXTAREA' ? win.HTMLTextAreaElement.prototype : win.HTMLInputElement.prototype;
            const setter = Object.getOwnPropertyDescriptor(proto, 'value').set;
            setter.call(el, text);
        } catch (e) {
            el.value = text;
        }
        el.dispatchEvent(new Event('input', { bubbles: true }));
        el.dispatchEvent(new Event('change', { bubbles: true }));
    }

    function isGrayColor(el) {
        if (!el) return false;
        const c = getComputedStyle(el).color;
        const m = c.match(/\d+/g);
        if (!m) return false;
        const [r, g, b] = m.map(Number);
        return Math.min(r, g, b) >= CFG.grayColorThreshold;
    }

    /* ===================== 文档获取：主文档 + 同源 iframe/frame（递归2层） ===================== */
    function getDocuments(doc, depth) {
        doc = doc || document;
        depth = depth || 0;
        const docs = [doc];
        if (depth >= 3) return docs;
        try {
            doc.querySelectorAll('iframe, frame').forEach(f => {
                try {
                    if (f.contentDocument) docs.push(...getDocuments(f.contentDocument, depth + 1));
                } catch (e) { /* 跨域 iframe 跳过 */ }
            });
        } catch (e) { /* ignore */ }
        return docs;
    }

    /* ===================== 大模型调用 ===================== */
    function rawLLMRequest(url, apiKey, bodyObj) {
        return new Promise((resolve, reject) => {
            GM_xmlhttpRequest({
                method: 'POST',
                url,
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': 'Bearer ' + apiKey,
                },
                data: JSON.stringify(bodyObj),
                timeout: CFG.llmTimeout,
                onload: (res) => {
                    let json;
                    try { json = JSON.parse(res.responseText); }
                    catch (e) {
                        return reject(new Error(`解析模型响应失败(HTTP ${res.status}): ` + (res.responseText || '').slice(0, 200)));
                    }
                    if (json.error) return reject(new Error(json.error.message || JSON.stringify(json.error)));
                    const content = json.choices?.[0]?.message?.content;
                    if (!content) return reject(new Error('模型返回为空'));
                    resolve(content);
                },
                onerror: (e) => reject(new Error('模型请求失败: ' + (e.error || (e.status ? 'HTTP ' + e.status : '网络错误')))),
                ontimeout: () => reject(new Error('模型请求超时')),
            });
        });
    }

    async function retryWithoutJsonFormat(url, apiKey, body, prevErr) {
        if (/response_format|json_object/i.test(prevErr.message)) {
            log('接口不支持 response_format，去除该参数后重试');
            const b2 = Object.assign({}, body);
            delete b2.response_format;
            return rawLLMRequest(url, apiKey, b2);
        }
        throw prevErr;
    }

    async function llmRequest(messages) {
        const conf = loadLLMConfig();
        if (!conf || !conf.apiKey) throw new Error('未配置 API Key');

        const provider = PROVIDERS[conf.provider] || PROVIDERS.deepseek;
        const baseURL = (conf.baseURL || provider.baseURL || '').replace(/\/+$/, '');
        const model = conf.model || provider.defaultModel;
        if (!baseURL) throw new Error('未配置接口地址(baseURL)');

        const url = baseURL + '/chat/completions';
        const body = { model, messages, temperature: 0.1, response_format: { type: 'json_object' } };

        log(`调用大模型 ${model} 答题中…`);

        try {
            return await rawLLMRequest(url, conf.apiKey, body);
        } catch (e1) {
            const m = e1.message.match(/supported API model names are\s+([^,，\s]+)/i);
            if (m) {
                const supported = m[1].trim().replace(/[.。]$/, '');
                log(`模型 ${model} 不被支持，自动切换为 ${supported} 并重试`);
                conf.model = supported;
                saveLLMConfig(conf);
                body.model = supported;
                const mi = document.getElementById('weauto-model');
                if (mi) mi.value = supported;
                try {
                    return await rawLLMRequest(url, conf.apiKey, body);
                } catch (e2) {
                    return retryWithoutJsonFormat(url, conf.apiKey, body, e2);
                }
            }
            return retryWithoutJsonFormat(url, conf.apiKey, body, e1);
        }
    }

    function parseLLMJson(content) {
        const cleaned = content.replace(/```(?:json)?/gi, '').trim();
        const start = cleaned.indexOf('{');
        const end = cleaned.lastIndexOf('}');
        if (start < 0 || end <= start) throw new Error('模型返回的 JSON 解析失败: ' + content.slice(0, 200));
        return JSON.parse(cleaned.slice(start, end + 1));
    }

    /* ===================== 选词填空题型（点黄空 → 底部选项栏 → 点选项） ===================== */

    // 读取一个空当前的"值"（input 用 value，其它元素用文本）
    function blankValue(el) {
        if (el.tagName === 'INPUT') return (el.value || '').trim();
        return textOf(el);
    }

    // 判断单个元素是否是"空"
    function isBlankElement(el) {
        if (!el || el.nodeType !== 1) return false;
        if (el.closest('#weauto-panel, #weauto-overlay, #weauto-ball')) return false;
        if (el.tagName === 'INPUT') return true;   // 由调用方过滤类型
        const t = textOf(el);
        if (t.length > 40) return false;
        const cls = String(el.className || '').toLowerCase();
        if (/blank|gap|cloze/.test(cls)) return true;
        if (/click\s*here/i.test(t)) return true;
        const bgm = getComputedStyle(el).backgroundColor.match(/\d+/g);
        if (bgm && bgm.length >= 3) {
            const [r, g, b] = bgm.map(Number);
            if (r > 220 && g > 195 && b < 235 && (r - b) > 12) return true;
        }
        return false;
    }

    // 找全部空：优先取页面真实的填空 input；否则退化为"黄底/click here"的 span
    function findAllBlanks() {
        const inputs = [];
        getDocuments().forEach(doc => {
            doc.querySelectorAll('input[data-itemtype="input"], input[readonly], input[data-solution]').forEach(inp => {
                if (inp.closest('#weauto-panel, #weauto-overlay, #weauto-ball')) return;
                if (inp.type !== 'text' && inp.type !== 'search' && inp.type !== '') return;
                const rect = inp.getBoundingClientRect();
                if (rect.width === 0 && rect.height === 0) return;
                inp.setAttribute(BLANK_ATTR, '1');
                inputs.push(inp);
            });
        });
        if (inputs.length) {
            // 页面若有带 data-index 的填空控件，只保留它们（排除搜索框等干扰）
            const indexed = inputs.filter(i => i.hasAttribute('data-index'));
            const list = indexed.length ? indexed : inputs;
            if (indexed.length) list.sort((a, b) => Number(a.dataset.index) - Number(b.dataset.index));
            return list;
        }

        // 兜底：非 input 形态的空
        const result = [];
        getDocuments().forEach(doc => {
            const els = [...doc.querySelectorAll('span, a, em, u, i, strong, font')].filter(el => {
                if (!isBlankElement(el)) return false;
                if (el.querySelector('span, a, em, u, i, strong, font, input, div')) return false;
                const rect = el.getBoundingClientRect();
                return rect.width > 0 || rect.height > 0;
            });
            els.forEach(el => {
                el.setAttribute(BLANK_ATTR, '1');
                result.push(el);
            });
        });
        return result;
    }

    function isBlankUnfilled(el) {
        if (el.hasAttribute('data-weauto-skip')) return false;
        if (el.tagName === 'INPUT') {
            // readonly input 用 value 判断；placeholder 不算内容
            return !(el.value || '').trim();
        }
        const t = textOf(el);
        return /click\s*here/i.test(t) || t === '';
    }

    // 提取空的正确答案（页面 data-solution，形如 "E.culture"）
    function blankSolution(el) {
        const s = el.getAttribute && el.getAttribute('data-solution');
        if (!s) return null;
        const m = s.trim().match(/^([A-Za-z])[\s\.、]*\s*(.+)$/);
        return m ? { letter: m[1].toUpperCase(), word: m[2].trim() } : { letter: '', word: s.trim() };
    }

    // 提取底部选项栏中的选项：[{el, letter, word, text}]
    function extractOptions(preferredDoc) {
        const docs = preferredDoc ? [preferredDoc, ...getDocuments().filter(d => d !== preferredDoc)] : getDocuments();
        for (const doc of docs) {
            const all = [...doc.querySelectorAll('span, a, li, div, p')].filter(el => {
                if (el.closest('#weauto-panel, #weauto-overlay, #weauto-ball')) return false;
                // 关键：排除任何包含输入框的元素（即"空"的容器），避免把空误当成选项
                if (el.querySelector('input, textarea, select')) return false;
                if (el.hasAttribute(BLANK_ATTR)) return false;
                const rect = el.getBoundingClientRect();
                if (rect.width === 0 && rect.height === 0) return false;
                const t = textOf(el).replace(/\s+/g, ' ').trim();
                return /^[A-Z][\.、]\s*\S+/.test(t) && t.length < 40;
            });
            const inner = all.filter(el => !all.some(o => o !== el && el.contains(o)));
            const seen = new Set();
            const opts = [];
            inner.forEach(el => {
                const t = textOf(el).replace(/\s+/g, ' ').trim();
                const m = t.match(/^([A-Z])[\.、]\s*(.+)$/);
                if (!m || seen.has(m[1])) return;
                seen.add(m[1]);
                opts.push({ el, letter: m[1], word: m[2].trim(), text: t });
            });
            if (opts.length >= 2) return opts.sort((a, b) => a.letter.localeCompare(b.letter));
        }
        return [];
    }

    // 提取短文文本（空替换为 __1__ __2__ …）
    function extractPassage(blanks) {
        let container = blanks[0].parentElement;
        while (container && !(blanks.every(b => container.contains(b)) && textOf(container).length > 100)) {
            container = container.parentElement;
        }
        if (!container) container = blanks[0].ownerDocument.body;

        const clone = container.cloneNode(true);
        const cloneBlanks = [...clone.querySelectorAll('[' + BLANK_ATTR + ']')];
        blanks.forEach((b, i) => {
            const cb = cloneBlanks[i];
            if (cb) cb.replaceWith(clone.ownerDocument.createTextNode(` __${i + 1}__ `));
        });
        return textOf(clone).replace(/\s+/g, ' ').trim().slice(0, 3000);
    }

    async function llmAnswerCloze(passage, blankCount, wordBank) {
        const systemPrompt =
            '你是英语选词填空答题助手。用户会给你一段带编号空格(__1__、__2__…)的英文短文，以及一个词库（每项形如 "A. remember"）。' +
            '规则：每个词最多只能使用一次；根据语法和语境为每个空格选出最合适的词。' +
            '你必须只返回一个JSON对象，格式：{"answers":[{"blank":1,"letter":"A","word":"remember"},…]}，覆盖所有空格，不要返回任何解释。';
        const user = JSON.stringify({ passage, blankCount, wordBank });
        const content = await llmRequest([
            { role: 'system', content: systemPrompt },
            { role: 'user', content: user },
        ]);
        const parsed = parseLLMJson(content);
        if (!parsed || !Array.isArray(parsed.answers)) throw new Error('模型返回格式不含 answers 数组');
        return parsed.answers;
    }

    const normWord = (s) => String(s || '').toLowerCase().replace(/[^a-z]/g, '');

    function findOptionByAnswer(opts, ans) {
        if (!ans || !opts.length) return null;
        const L = ans.letter ? String(ans.letter).toUpperCase() : '';
        const W = normWord(ans.word);
        if (L) {
            const o = opts.find(x => x.letter.toUpperCase() === L);
            if (o) return o;
        }
        if (W) {
            return opts.find(x => normWord(x.word) === W)
                || opts.find(x => normWord(x.word).includes(W))
                || opts.find(x => W.includes(normWord(x.word)))
                || null;
        }
        return null;
    }

    async function fillCloze() {
        const blanks0 = findAllBlanks();
        if (!blanks0.length) return false;

        const blankCount = blanks0.length;
        log(`检测到选词填空题型，共 ${blankCount} 个空`);

        const passage = extractPassage(blanks0);

        // 打开选项栏：点击该空
        async function openOptionBarFor(blankEl) {
            blankEl.scrollIntoView({ block: 'center' });
            realClick(blankEl);
            if (blankEl.tagName === 'INPUT') blankEl.focus();
            await sleep(CFG.optionBarDelay);
            let o = extractOptions(blankEl.ownerDocument);
            if (o.length >= 2) return o;
            // 再尝试点击其父容器（部分控件把点击事件绑在包裹层上）
            if (blankEl.parentElement) {
                realClick(blankEl.parentElement);
                await sleep(CFG.optionBarDelay);
                o = extractOptions(blankEl.ownerDocument);
            }
            return o;
        }

        let opts = await openOptionBarFor(blanks0[0]);
        if (!opts.length) opts = await openOptionBarFor(blanks0[0]);
        if (opts.length) {
            log(`提取到词库 ${opts.length} 项: ${opts.map(o => o.text).join(' | ').slice(0, 160)}`);
        } else {
            log('警告：未提取到底部选项栏词库');
        }

        // 大模型一次性给出所有答案
        let answers = [];
        const llmConf = loadLLMConfig();
        if (llmConf && llmConf.apiKey && opts.length) {
            try {
                answers = await llmAnswerCloze(passage, blankCount, opts.map(o => o.text));
                log(`大模型已返回 ${answers.length} 个答案`);
            } catch (e) {
                log('大模型作答失败:', e.message, '—— 使用页面内置答案');
            }
        } else if (!llmConf || !llmConf.apiKey) {
            log('未配置大模型，使用页面内置答案');
        }

        const currentBlanks = () => findAllBlanks();

        // 坐标级点击：对元素视觉位置上的真实顶层元素派发事件
        async function clickByPoint(el) {
            const doc = el.ownerDocument;
            const r = el.getBoundingClientRect();
            if (r.width === 0 || r.height === 0) return null;
            const topEl = doc.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
            if (topEl) realClick(topEl);
            return topEl;
        }

        // 直接写入答案（最终保底手段，确保空被真正填上）
        async function writeValueDirect(blankEl, option) {
            const val = `${option.letter}. ${option.word}`;
            if (blankEl.tagName === 'INPUT') {
                blankEl.removeAttribute('readonly');
                blankEl.value = val;
                blankEl.dispatchEvent(new Event('input', { bubbles: true }));
                blankEl.dispatchEvent(new Event('change', { bubbles: true }));
                blankEl.dispatchEvent(new Event('blur', { bubbles: true }));
                blankEl.setAttribute('readonly', '');
            } else {
                blankEl.textContent = val;
            }
            await sleep(400);
            return blankValue(blankEl) !== '';
        }

        // 点选项并验证（多级升级）
        async function clickOptionAndVerify(opt, blankEl) {
            const filled = () => blankValue(blankEl) !== '';

            realClick(opt.el);
            await sleep(650);
            if (filled()) return '点击选项';

            const anc = opt.el.closest('a, [onclick], li');
            if (anc && anc !== opt.el) {
                realClick(anc);
                await sleep(650);
                if (filled()) return '点击选项祖先';
            }

            const topEl = await clickByPoint(opt.el);
            await sleep(650);
            if (filled()) return '坐标点击';

            // 点击选项内最深的文本节点宿主
            const leaf = [...opt.el.querySelectorAll('*')].filter(x => !x.children.length).pop();
            if (leaf) {
                realClick(leaf);
                await sleep(650);
                if (filled()) return '点击选项内层';
            }
            log(`　诊断: 选项=${(opt.el.outerHTML || '').replace(/\s+/g, ' ').slice(0, 120)}`);
            log(`　诊断: 顶层元素=${topEl ? topEl.tagName : 'null'}`);
            return null;
        }

        const usedLetters = new Set();
        let activeIdx = -1;
        let filledCount = 0;

        for (let i = 0; i < blankCount; i++) {
            if (isStopped()) { log('检测到停止指令，中止选词填空'); return true; }
            const all = currentBlanks();
            const blankEl = all[i];
            if (!blankEl) continue;
            if (!isBlankUnfilled(blankEl)) { filledCount++; continue; }

            const ans = answers.find(a => Number(a.blank) === i + 1);
            const sol = blankSolution(blankEl);

            // 选项栏未针对本空打开时，先点击本空
            if (activeIdx !== i || extractOptions(blankEl.ownerDocument).length < 2) {
                opts = await openOptionBarFor(blankEl);
                activeIdx = i;
            }
            if (opts.length < 2) {
                log(`第 ${i + 1} 空：选项栏未出现，尝试直接写入`);
                if (sol && await writeValueDirect(blankEl, { letter: sol.letter, word: sol.word })) {
                    filledCount++; usedLetters.add(sol.letter);
                    log(`第 ${i + 1} 空：直接写入成功 (${sol.letter}. ${sol.word})`);
                } else {
                    blankEl.setAttribute('data-weauto-skip', '1');
                    log(`第 ${i + 1} 空：写入失败，跳过`);
                }
                continue;
            }

            // 选答案：模型答案 → 页面内置答案 → 未用过的选项
            let target = findOptionByAnswer(opts, ans);
            let src = '大模型';
            if (!target && sol) { target = findOptionByAnswer(opts, sol); src = '页面答案'; }
            if (!target) {
                target = opts.find(o => !usedLetters.has(o.letter)) || opts[0];
                src = '兜底';
            }
            log(`第 ${i + 1} 空：${src}答案 → ${target.text}`);

            let how = await clickOptionAndVerify(target, blankEl);
            if (!how) {
                // 兜底：直接写入
                const w = sol || { letter: target.letter, word: target.word };
                if (await writeValueDirect(blankEl, w)) {
                    how = '直接写入';
                    filledCount++;
                    usedLetters.add(w.letter);
                    log(`第 ${i + 1} 空：人工点击无效，已直接写入 (${w.letter}. ${w.word})`);
                    activeIdx = -1;
                    continue;
                }
                blankEl.setAttribute('data-weauto-skip', '1');
                log(`第 ${i + 1} 空：无法填入，跳过`);
                activeIdx = -1;
                continue;
            }
            filledCount++;
            usedLetters.add(target.letter);
            log(`第 ${i + 1} 空：填入成功（${how}）`);
            activeIdx = -1; // 填入后选项栏通常关闭，下一空需重新点击
            await sleep(300);
        }

        const remain = currentBlanks().filter(isBlankUnfilled).length;
        log(`填空完成：成功 ${filledCount}/${blankCount}，剩余未填 ${remain}`);
        return true;
    }

    /* ===================== 选词填空·单词选项版（底部为纯单词，无字母前缀） ===================== */

    // 提取底部选项栏的纯单词选项：[{el, word, letter:'', text}]
    const WORD_UI_STOP = new Set(['submit', 'reset', 'next', 'previous', 'prev', 'retract', 'expand', 'ok', 'yes', 'no', 'cancel', 'save', 'copy', 'clear', 'start', 'stop']);
    function extractWordOptions(preferredDoc) {
        const docs = preferredDoc ? [preferredDoc, ...getDocuments().filter(d => d !== preferredDoc)] : getDocuments();
        for (const doc of docs) {
            const vh = (doc.defaultView || window).innerHeight || 800;
            const els = [...doc.querySelectorAll('span, a, li, div, button, p')].filter(el => {
                if (el.closest('#weauto-panel, #weauto-overlay, #weauto-ball')) return false;
                if (el.tagName === 'INPUT') return false;
                if (el.querySelector('input, textarea, select')) return false;
                if (el.hasAttribute(BLANK_ATTR)) return false;
                const t = textOf(el).trim();
                if (!/^[A-Za-z][A-Za-z'’-]*$/.test(t) || t.length < 2 || t.length > 20) return false;
                if (WORD_UI_STOP.has(t.toLowerCase())) return false; // 排除 Submit/Reset 等界面控制词
                const r = el.getBoundingClientRect();
                if (r.width === 0 || r.height === 0) return false;
                if (r.top < vh * 0.6) return false; // 只要底部选项栏，排除题干句子里的单词
                return true;
            });
            const inner = els.filter(el => !els.some(o => o !== el && el.contains(o)));
            const seen = new Set(); const out = [];
            inner.forEach(el => {
                const w = textOf(el).trim();
                if (seen.has(w.toLowerCase())) return;
                seen.add(w.toLowerCase());
                out.push({ el, word: w, letter: '', text: w });
            });
            if (out.length >= 3) return out.sort((a, b) => a.word.localeCompare(b.word));
        }
        return [];
    }

    async function llmAnswerWordBank(items, wordBank) {
        const systemPrompt =
            '你是英语选词填空助手。用户给出若干句子(items，含编号blank和句子sentence，句中下划线短语为提示)和一个单词库wordBank。' +
            '请为每个空选出与下划线短语意思最接近的单词，每个单词最多用一次。' +
            '只返回JSON对象 {"answers":[{"blank":1,"word":"launch"},…]}，覆盖所有空，不要返回任何解释。';
        const content = await llmRequest([
            { role: 'system', content: systemPrompt },
            { role: 'user', content: JSON.stringify({ items, wordBank }) },
        ]);
        const parsed = parseLLMJson(content);
        if (!parsed || !Array.isArray(parsed.answers)) throw new Error('模型返回格式不含 answers 数组');
        return parsed.answers;
    }

    async function fillWordBank() {
        const blanks0 = findAllBlanks();
        if (!blanks0.length) return false;

        async function openBar(b) {
            b.scrollIntoView({ block: 'center' });
            realClick(b);
            if (b.tagName === 'INPUT') b.focus();
            await sleep(CFG.optionBarDelay);
            let o = extractWordOptions(b.ownerDocument);
            if (o.length >= 2) return o;
            if (b.parentElement) { realClick(b.parentElement); await sleep(CFG.optionBarDelay); o = extractWordOptions(b.ownerDocument); }
            return o;
        }

        const opts = await openBar(blanks0[0]);
        if (!opts.length) return false; // 底部不是纯单词选项 → 交给 fillCloze / 其它题型
        log(`检测到选词填空·单词选项版，共 ${blanks0.length} 个空，词库 ${opts.length} 项: ${opts.map(o => o.word).join(' | ').slice(0, 160)}`);

        const items = blanks0.map((b, i) => ({
            blank: i + 1,
            sentence: (b.parentElement ? textOf(b.parentElement) : '').replace(/\s+/g, ' ').trim().slice(0, 300),
        }));

        let answers = [];
        const conf = loadLLMConfig();
        if (conf && conf.apiKey) {
            try { answers = await llmAnswerWordBank(items, opts.map(o => o.word)); log(`大模型已返回 ${answers.length} 个答案`); }
            catch (e) { log('大模型作答失败:', e.message, '—— 使用页面内置答案'); }
        } else log('未配置大模型，使用页面内置答案');

        const used = new Set(); let filled = 0;
        for (let i = 0; i < blanks0.length; i++) {
            if (isStopped()) { log('检测到停止指令，中止单词填空'); return true; }
            const b = findAllBlanks()[i];
            if (!b) continue;
            if (!isBlankUnfilled(b)) { filled++; continue; }

            const ans = answers.find(a => Number(a.blank) === i + 1);
            const solWord = ((b.getAttribute && b.getAttribute('data-solution')) || '').trim();
            let target = opts.find(o => ans && o.word.toLowerCase() === String(ans.word).toLowerCase());
            let src = '大模型';
            if (!target && solWord) { target = opts.find(o => o.word.toLowerCase() === solWord.toLowerCase()); src = '页面答案'; }
            if (!target) { target = opts.find(o => !used.has(o.word)) || opts[0]; src = '兜底'; }

            // 每空都先点击激活（选项栏只填当前激活的空），再取单词选项
            let cur = await openBar(b);
            if (cur.length < 2) cur = opts;
            const opt = cur.find(o => o.word === target.word) || target;
            log(`第 ${i + 1} 空：${src} → ${opt.word}`);

            realClick(opt.el); await sleep(650);
            if (blankValue(b) === '') {
                const r = opt.el.getBoundingClientRect();
                if (r.width > 0 && r.height > 0) {
                    const top = b.ownerDocument.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
                    if (top) realClick(top);
                    await sleep(650);
                }
            }
            if (blankValue(b) === '') { // 直接写入纯单词（不带字母前缀）
                if (b.tagName === 'INPUT') {
                    b.removeAttribute('readonly'); b.value = opt.word;
                    b.dispatchEvent(new Event('input', { bubbles: true }));
                    b.dispatchEvent(new Event('change', { bubbles: true }));
                    b.setAttribute('readonly', '');
                } else b.textContent = opt.word;
                await sleep(300);
            }
            if (blankValue(b) !== '') { filled++; used.add(opt.word); log(`第 ${i + 1} 空：填入成功 (${blankValue(b)})`); }
            else log(`第 ${i + 1} 空：无法填入，跳过`);
            await sleep(200);
        }
        log(`单词选词填空完成：成功 ${filled}/${blanks0.length}`);

        // ===== 终检补填 =====
        // 站点规则：一个单词选项只能被一个空占用，后一个空再点同一个选项会把前一个空撤掉。
        // 所以填完后必须复核：找出仍为空的空，用"唯一没被任何空选中的选项"补上。
        await fixUnfilledWordBankBlanks(opts);
        return true;
    }

    // 从空盒当前显示的文字里取出纯单词（兼容 "G. perceive" 这种带字母前缀的写法）
    function wordFromBlank(b) {
        let v = blankValue(b) || "";
        v = v.replace(/\s+/g, " ").trim();
        const m = v.match(/^[A-Za-z]\s*[\.、]\s*(.+)$/);
        if (m) v = m[1].trim();
        return v;
    }

    // 终检专用：更宽松地取词库选项。
    // 原 extractWordOptions 只认"视口底部 40% 且至少 3 项"，补填时页面滚动位置不固定容易拿不到，
    // 所以先走原规则，失败则全文档扫描纯单词元素兜底。
    // 终检专用：不受"视口底部 40%"限制地取词库选项。
    // 原 extractWordOptions 只看视口底部 40% 区域，词库一长（如 15 项需滚动）就会漏项，
    // 导致"未被使用的选项 0 个"算不出剩余。这里改为全文档扫描，并按字母前缀去重。
    function extractWordOptionsLoose(preferredDoc) {
        const docs = preferredDoc ? [preferredDoc, ...getDocuments().filter(d => d !== preferredDoc)] : getDocuments();
        for (const doc of docs) {
            const els = [...doc.querySelectorAll("span, a, li, div, button, p, td")].filter(el => {
                if (el.closest("#weauto-panel, #weauto-overlay, #weauto-ball")) return false;
                if (el.tagName === "INPUT") return false;
                if (el.querySelector("input, textarea, select")) return false;
                if (el.hasAttribute(BLANK_ATTR)) return false;
                const t = textOf(el).trim();
                // 允许词组（如 "to date"、"in vain"）：1~3 个英文单词，可含空格/连字符/撇号
                if (!/^[A-Za-z][A-Za-z\u2019'\- ]*$/.test(t) || t.length < 2 || t.length > 24) return false;
                if (t.split(/\s+/).length > 3) return false;
                if (WORD_UI_STOP.has(t.toLowerCase())) return false;
                const r = el.getBoundingClientRect();
                return r.width > 0 && r.height > 0;
            });
            const inner = els.filter(el => !els.some(o => o !== el && el.contains(o)));
            const seen = new Set(); const out = [];
            inner.forEach(el => {
                const w = textOf(el).trim();
                if (seen.has(w.toLowerCase())) return;
                seen.add(w.toLowerCase());
                out.push({ el, word: w, letter: "", text: w });
            });
            // 全文档扫描容易把题干里的单词也收进来；只有当"看起来像词库"(>=3 项) 时才采信
            if (out.length >= 3) return out.sort((a, b) => a.word.localeCompare(b.word));
        }
        return [];
    }

    // 从页面 dom 里直接读出该空的"标准答案"单词（data-solution 形如 "B.compels" / "compels"）
    function solutionWordOf(blankEl) {
        if (!blankEl || !blankEl.getAttribute) return "";
        const raw = (blankEl.getAttribute("data-solution") || "").trim();
        if (!raw) return "";
        if (/[\u4e00-\u9fa5]/.test(raw)) return "";
        const m = raw.match(/^([A-Za-z])\s*[\.、]\s*(.+)$/);
        return (m ? m[2] : raw).trim();
    }

    // 终检：把仍为空的空，用"没被其他空占用"的选项补上。
    // 只补空白的空，绝不动已填好的空。
    // 先走"全同步"快速通道（不 await，直接点空盒+点选项+读回校验）——
    // 因为后台标签页里 setTimeout / MessageChannel 都会被浏览器冻结，异步等待会把流程卡死；
    // 同步通道仍有空时，才退回带短等待的异步重试。
    async function fixUnfilledWordBankBlanks(opts) {
        if (!opts || opts.length < 2) return;
        try {
            const readBlanks = () => findAllBlanks();

            // 已被占用的单词集合
            const usedWords = () => {
                const set = new Set();
                readBlanks().forEach(b => {
                    const w = wordFromBlank(b);
                    if (w) set.add(w.toLowerCase());
                });
                return set;
            };

            // 同步点击一个选项：点空盒激活 -> 点选项 -> 读回校验（不等待）
            const clickOptionSync = (blankEl, targetWord) => {
                if (!blankEl || !blankEl.isConnected) return false;
                try { blankEl.scrollIntoView({ block: "center" }); } catch (e) { /* ignore */ }
                realClick(blankEl);
                if (blankEl.tagName === "INPUT") { try { blankEl.focus(); } catch (e) { /* ignore */ } }

                let live = extractWordOptionsLoose(blankEl.ownerDocument);
                let opt = live.find(o => o.word.toLowerCase() === targetWord.toLowerCase());
                if (!opt && blankEl.parentElement) {
                    realClick(blankEl.parentElement);
                    live = extractWordOptionsLoose(blankEl.ownerDocument);
                    opt = live.find(o => o.word.toLowerCase() === targetWord.toLowerCase());
                }
                if (!opt || !opt.el || !opt.el.isConnected) return !!wordFromBlank(blankEl);

                realClick(opt.el);
                if (wordFromBlank(blankEl)) return true;

                const r = opt.el.getBoundingClientRect();
                if (r.width > 0 && r.height > 0) {
                    const topEl = blankEl.ownerDocument.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
                    if (topEl) realClick(topEl);
                }
                if (wordFromBlank(blankEl)) return true;

                const anc = opt.el.closest("a, button, li, [onclick], label");
                if (anc && anc !== opt.el) realClick(anc);
                if (wordFromBlank(blankEl)) return true;

                if (blankEl.tagName === "INPUT") {
                    blankEl.removeAttribute("readonly");
                    blankEl.value = targetWord;
                    blankEl.dispatchEvent(new Event("input", { bubbles: true }));
                    blankEl.dispatchEvent(new Event("change", { bubbles: true }));
                    blankEl.setAttribute("readonly", "");
                }
                return !!wordFromBlank(blankEl);
            };

            // 决定某个空该填什么：
            //   1) 页面记录的标准答案（data-solution）——最可靠，直接用它恢复被误清空的空；
            //   2) 词库里"没被任何空占用"的词；
            //   3) 词库任意一项（宁可填一个占位词，也比留空强，至少能提交）。
            const decideWord = (blankEl) => {
                // 优先级：
                //   1) 词库里"完全没被占用"的词 —— 首选，绝不会挤掉别的空；
                //   2) 页面答案(data-solution) —— 但它可能已被别的空占用，会挤掉对方，故排第二；
                //   3) 重复项 / 兜底。
                const used = usedWords();
                const free = opts.filter(o => !used.has(o.word.toLowerCase()));
                if (free.length) return { word: free[0].word, src: "剩余选项" };

                const sol = solutionWordOf(blankEl);
                if (sol) return { word: sol, src: "页面答案" };

                // 全部被占用：挑一个"重复最多"的词腾出来，用在该空
                const count = new Map();
                readBlanks().forEach(b => {
                    const w = wordFromBlank(b);
                    if (!w) return;
                    const k = w.toLowerCase();
                    count.set(k, (count.get(k) || 0) + 1);
                });
                let dup = "", max = 0;
                count.forEach((v, k) => { if (v > max) { max = v; dup = k; } });
                if (dup && max >= 2) {
                    const hit = opts.find(o => o.word.toLowerCase() === dup);
                    if (hit) return { word: hit.word, src: "重复项" };
                }
                return { word: opts[0].word, src: "兜底" };
            };

            // ---- 第一遍：同步快速补填 ----
            let empties = readBlanks().map((el, i) => ({ el, idx: i + 1 })).filter(x => !wordFromBlank(x.el));
            if (!empties.length) { log("终检：所有空均已填写"); return; }

            const used0 = usedWords();
            const free0 = opts.filter(o => !used0.has(o.word.toLowerCase()));
            log("终检：" + empties.length + " 个空未选中，词库 " + opts.length + " 项，未被使用 " + free0.length + " 个" + (free0.length ? ": " + free0.map(o => o.word).join(" | ") : ""));

            for (const x of empties) {
                if (isStopped()) { log("检测到停止指令，中止终检补填"); return; }
                const blankEl = readBlanks()[x.idx - 1];
                if (!blankEl || !blankEl.isConnected) { log("第 " + x.idx + " 空：空盒已失效，跳过"); continue; }
                if (wordFromBlank(blankEl)) continue;

                const pick = decideWord(blankEl);
                if (!pick || !pick.word) { log("第 " + x.idx + " 空：无法确定答案，跳过"); continue; }

                if (clickOptionSync(blankEl, pick.word)) {
                    log("第 " + x.idx + " 空：" + pick.src + " → " + pick.word + " 补填成功 (" + blankValue(blankEl) + ")");
                } else {
                    log("第 " + x.idx + " 空：" + pick.src + " → " + pick.word + " 同步补填未成功，稍后重试");
                }
            }

            // ---- 第二遍：仍有空的，带短等待再试 2 轮 ----
            for (let round = 1; round <= 2; round++) {
                if (isStopped()) return;
                const left = readBlanks().map((el, i) => ({ el, idx: i + 1 })).filter(x => !wordFromBlank(x.el));
                if (!left.length) break;
                log("终检补填第 " + round + " 轮：仍有 " + left.length + " 个空");
                let changed = false;
                for (const x of left) {
                    if (isStopped()) return;
                    const blankEl = readBlanks()[x.idx - 1];
                    if (!blankEl || !blankEl.isConnected || wordFromBlank(blankEl)) continue;
                    const pick = decideWord(blankEl);
                    if (!pick || !pick.word) continue;

                    try { blankEl.scrollIntoView({ block: "center" }); } catch (e) { /* ignore */ }
                    await sleep(200);
                    realClick(blankEl);
                    await sleep(CFG.optionBarDelay);
                    const live = extractWordOptionsLoose(blankEl.ownerDocument);
                    const opt = live.find(o => o.word.toLowerCase() === pick.word.toLowerCase());
                    if (opt && opt.el && opt.el.isConnected) { realClick(opt.el); await sleep(500); }
                    if (wordFromBlank(blankEl)) {
                        changed = true;
                        log("第 " + x.idx + " 空：" + pick.src + " → " + pick.word + " 补填成功 (" + blankValue(blankEl) + ")");
                    }
                }
                if (!changed) break;
            }

            // ---- 第三遍：站点是"选项排他"的（一个词只能占一个空），
            // 补填 A 空可能把原本在 B 空的同词挤掉，导致 B 空变空。
            // 所以这里循环补填，直到"没有空格"或"连续两轮无进展"为止。
            for (let pass = 1; pass <= 8; pass++) {
                if (isStopped()) return;
                const leftNow = readBlanks().map((el, i) => ({ el, idx: i + 1 })).filter(x => !wordFromBlank(x.el));
                if (!leftNow.length) break;

                let progressed = false;
                for (const x of leftNow) {
                    if (isStopped()) return;
                    const blankEl = readBlanks()[x.idx - 1];
                    if (!blankEl || !blankEl.isConnected || wordFromBlank(blankEl)) continue;
                    const pick = decideWord(blankEl);
                    if (!pick || !pick.word) continue;

                    // 先看当前是否已有别的空占着这个词：若有且那个空是"错的"，先清掉它再填
                    const holderIdx = readBlanks().findIndex((bb, bi) => bi !== (x.idx - 1) &&
                        wordFromBlank(bb).toLowerCase() === pick.word.toLowerCase());

                    if (clickOptionSync(blankEl, pick.word)) {
                        progressed = true;
                        log("第 " + x.idx + " 空：" + pick.src + " → " + pick.word + " 补填成功 (" + blankValue(blankEl) + ")");
                        // 若该词原先占着别的空，那个空现在会变空，交给下一轮继续补
                    } else {
                        log("第 " + x.idx + " 空：" + pick.src + " → " + pick.word + " 补填失败");
                    }
                }

                const still = readBlanks().filter(bb => !wordFromBlank(bb)).length;
                log("终检第 " + pass + " 遍结束：仍为空 " + still + " 个");
                if (!still) break;
                if (!progressed) break;   // 无进展，停止避免死循环
            }

            const after = readBlanks();
            const stillEmpty = after.filter(bb => !wordFromBlank(bb)).length;
            log("终检结果：" + after.length + " 个空，仍为空 " + stillEmpty + " 个");
        } catch (e) {
            log("终检补填异常(不影响已填答案):", e.message);
        }
    }



    /* ===================== 语法填空题（空右侧带括号提示词，填其变形） ===================== */

    // 取空右侧括号内的提示词（从句子文本中 __idx__ 后的 (word) 提取）
    function grammarHint(sentence, idx) {
        const m = sentence.match(new RegExp('__' + idx + '__\\s*\\(([^)]+)\\)'));
        return m ? m[1].trim() : null;
    }

    async function llmAnswerGrammar(items, instruction) {
        const systemPrompt =
            '你是高考英语语法填空命题级专家。每个空(items)给出完整句子sentence(空位__编号__)与括号内提示词base，答案是base的恰当变形。严格按以下流程逐空推理：' +
            '①通读整句，理解主旨与逻辑(褒贬/并列/转折/因果)，并判断空格在句中所作成分与所需词性(主/谓/宾/定/状/表)。' +
            '②按base词性走决策树：' +
            '  ·动词：句中无谓语→作谓语(依语篇时态定一般现在/过去/完成/将来，依主被动定语态，依主语定单复)；已有谓语→非谓语(to do表目的/将来、doing表主动/进行/动名词、done表被动/完成)；或转名词(-tion/-ment/-ing/-er/-ance/-al)、转形容词(-ed/-ing)。' +
            '  ·名词：可数注意单复数与所有格(\'s)，或转形容词(-ful/-ous/-al/-y/-able/-less)。' +
            '  ·形容词/副词：有than/the/范围→比较级/最高级(注意good-better/bad-worse)；修饰动词或全句→加-ly变副词；需名词→-ness/-ity；语义为反义→加否定前缀(un-/im-/in-/dis-/non-/anti-/counter-)。' +
            '  ·代词：主/宾/形物/名物/反身；数词：基数→序数。' +
            '③结合上下文语义确定正反义(如"want…work simply"要"简单"，故complicated→uncomplicated；"offer is very…"结合语境可能为unattractive)。' +
            '④复核拼写/单复数/大小写。' +
            '只返回JSON对象 {"answers":[{"blank":1,"word":"uncomplicated"},…]}，覆盖所有空，不要返回解释。';
        const content = await llmRequest([
            { role: 'system', content: systemPrompt },
            { role: 'user', content: JSON.stringify({ instruction, items }) },
        ]);
        const parsed = parseLLMJson(content);
        if (!parsed || !Array.isArray(parsed.answers)) throw new Error('模型返回格式不含 answers 数组');
        return parsed.answers;
    }

    // 复核：把已填答案代回句子，让模型纠错，仅返回需要修改的空
    async function llmVerifyGrammar(items, answers) {
        const filled = items.map(it => {
            const a = answers.find(x => Number(x.blank) === it.blank);
            return { blank: it.blank, base: it.base, sentence: it.sentence.replace('__' + it.blank + '__', a ? a.word : '__') };
        });
        const systemPrompt =
            '复核英语语法填空答案。给出已填好单词的句子(sentence)与原提示词base。' +
            '若某空单词在词性/时态/语态/单复数/正反义/搭配上不正确，给出正确变形；若全部正确则不返回任何修改。' +
            '只返回JSON对象 {"corrections":[{"blank":2,"word":"inequalities"}]}，无修改时返回 {"corrections":[]}。';
        const content = await llmRequest([
            { role: 'system', content: systemPrompt },
            { role: 'user', content: JSON.stringify({ items: filled }) },
        ]);
        const parsed = parseLLMJson(content);
        return (parsed && Array.isArray(parsed.corrections)) ? parsed.corrections : [];
    }

    async function fillGrammar() {
        const inputs = findFreeInputs();
        if (!inputs.length) return false;

        const items = inputs.map((inp, i) => {
            const sentence = sentenceFor(inp, i + 1);
            return { blank: i + 1, sentence, base: grammarHint(sentence, i + 1) };
        });
        // 判定：首个空右侧有括号提示词才算语法填空（否则交给自由输入填空）
        if (!items[0] || !items[0].base) return false;

        inputs[0].scrollIntoView({ block: 'center' });
        realClick(inputs[0]);
        inputs[0].focus();
        await sleep(CFG.optionBarDelay);
        if (extractOptions(inputs[0].ownerDocument).length >= 2 || extractWordOptions(inputs[0].ownerDocument).length >= 2) return false;

        log(`检测到语法填空题，共 ${inputs.length} 个空，提示词: ${items.map(i => i.base).join(', ').slice(0, 120)}`);
        const instruction = (getDocuments().map(d => textOf(d.body)).join(' ').match(/Fill in[^.]*\./i) || [''])[0];

        let answers = [];
        const conf = loadLLMConfig();
        if (conf && conf.apiKey) {
            try {
                answers = await llmAnswerGrammar(items, instruction);
                log(`大模型已返回 ${answers.length} 个答案`);
                // 复核：代回句子纠错，提升正确率
                try {
                    const fixes = await llmVerifyGrammar(items, answers);
                    if (fixes.length) {
                        fixes.forEach(f => {
                            const a = answers.find(x => Number(x.blank) === Number(f.blank));
                            if (a && f.word) { log(`复核修正 第${f.blank}空: ${a.word} → ${f.word}`); a.word = f.word; }
                            else if (f.word) answers.push({ blank: Number(f.blank), word: f.word });
                        });
                    } else log('复核通过，无修改');
                } catch (e) { log('复核失败(不影响作答):', e.message); }
            } catch (e) { log('大模型作答失败:', e.message, '—— 使用页面内置答案'); }
        } else log('未配置大模型，使用页面内置答案');

        let filled = 0;
        for (let i = 0; i < inputs.length; i++) {
            if (isStopped()) { log('检测到停止指令，中止语法填空'); return true; }
            const inp = inputs[i];
            if (!inp.isConnected) continue;
            if ((inp.value || '').trim()) { filled++; continue; }

            const ans = answers.find(a => Number(a.blank) === i + 1);
            const sol = ((inp.getAttribute && inp.getAttribute('data-solution')) || '').trim();
            const word = (ans && String(ans.word).trim()) || sol;
            if (!word) { log(`第 ${i + 1} 空：无答案，跳过`); continue; }

            inp.scrollIntoView({ block: 'center' });
            realClick(inp);
            inp.focus();
            setNativeValue(inp, word);
            await sleep(250);
            if ((inp.value || '').trim()) { filled++; log(`第 ${i + 1} 空：(${items[i].base}) → ${inp.value}`); }
            else log(`第 ${i + 1} 空：写入失败，跳过`);
        }
        log(`语法填空完成：成功 ${filled}/${inputs.length}`);
        return true;
    }

    /* ===================== 复合词构词法填空（黄色空盒 + 括号内两个词根） =====================
       页面样例：
         It seems [____] (ill, advise) for a college student to apply for student loans.
         Freshly baked scones and [____] (mouth, water) cakes are the charms of an afternoon tea.
       规律：空右侧括号里是"两个英文词根"，需要按构词法拼成一个复合词（多为复合形容词）。
       与语法填空的区别：括号里只有一个词根 → 语法填空；有底部单词选项栏 → 选词填空；这里都不是。 */

    // 从"空右侧最近的括号"里取两个词根。忽略中文注释（如 (自由职业者)）。
    function compoundRootsNear(el, idx) {
        // 取空所在的整句容器（与语法填空同一套逻辑），把空替换成标记再匹配
        const sentence = el.__compoundSentence !== undefined
            ? el.__compoundSentence
            : sentenceFor(el, idx);
        if (!sentence) return null;
        // 空标记后面紧跟的括号；允许中间有少量空格/标点
        const re = new RegExp('__' + idx + '__\\s*\\(([^)]*)\\)');
        const m = sentence.match(re);
        if (!m) return null;
        const inner = m[1];
        // 括号里必须恰好是两个"纯英文词根"，逗号分隔（可能带 / 或 and）
        if (/[\u4e00-\u9fa5]/.test(inner)) return null;          // 含中文注释 → 不是本题型
        const parts = inner.split(/\s*[,，/]\s*/).map(s => s.trim()).filter(Boolean);
        if (parts.length !== 2) return null;
        if (!parts.every(p => /^[A-Za-z][A-Za-z'\-]*$/.test(p))) return null;
        return { first: parts[0].toLowerCase(), second: parts[1].toLowerCase(), raw: inner.trim() };
    }

    // 找出所有"空盒 + 括号两个词根"的题：[{index, el, sentence, roots}]
    function findCompoundItems() {
        const out = [];
        // 空盒候选：可编辑且非 readonly 的输入框（本题型点开即可直接输入）
        const inputs = findFreeInputs();
        const list = inputs.length ? inputs : findAllBlanks();
        list.forEach((el, i) => {
            if (el.closest('#weauto-panel, #weauto-overlay, #weauto-ball')) return;
            const sentence = sentenceFor(el, i + 1);
            if (!sentence) return;
            const saved = el.__compoundSentence;
            el.__compoundSentence = sentence;
            const roots = compoundRootsNear(el, i + 1);
            el.__compoundSentence = saved;
            if (!roots) return;
            out.push({ index: out.length + 1, el, sentence, roots });
        });
        return out;
    }

    // 题型判定：存在"括号两个词根"的空盒，且没有底部单词选项栏（排除选词填空）
    function looksLikeCompoundFill() {
        const items = findCompoundItems();
        if (!items.length) return false;
        for (const doc of getDocuments()) {
            if (extractWordOptions(doc).length >= 2) return false;   // 有选项栏 → 选词填空
            if (extractOptions(doc).length >= 2 && /^\s*[A-Z][\.、]/.test(textOf(doc.body).trim())) return false;
        }
        return true;
    }

    // 上下文里给模型看：把空替换成 ___ ，去掉中文注释干扰
    function compoundPromptSentence(sentence, idx) {
        return String(sentence || '')
            .replace(new RegExp('__' + idx + '__'), ' ___ ')
            // 去掉"（中文）"整段括号注释（全角/半角括号都处理）
            .replace(/[（(]\s*[\u4e00-\u9fa5][^）)]*[）)]/g, ' ')
            // 去掉剩下的裸中文（含相邻标点）
            .replace(/[\u4e00-\u9fa5]+/g, ' ')
            .replace(/\s+/g, ' ')
            .trim();
    }

    async function llmAnswerCompound(items) {
        const systemPrompt =
            '你是英语复合词（compound word）构词法填空专家。每道题给出完整句子sentence（空位为 ___ ）和括号里的两个词根roots（形如 ["ill","advise"]），' +
            '要求把这两个词根按构词法拼合成一个复合词填入空格。请严格按下面顺序作答（思考过程不要输出）：\n' +
            '1. 阅读整句，判断空格处所需的词性（本题型几乎都是形容词，作定语修饰后面的名词，或作表语）；\n' +
            '2. 判断构词模式：副词+过去分词（ill-informed）、名词+现在分词（peace-loving）、代词/反身+名词+ed（self-employed）、' +
            '  名词+名词+ed（heart-broken）、形容词+名词+ed（absent-minded），以及已经固化为词典词的合成词（everlasting、heartbreaking）；\n' +
            '3. 决定分词形式：现在分词 -ing 表"令人…的/主动"（mouth-watering cakes = 令人垂涎的）；' +
            '  过去分词 -ed 表"被…的/处于某状态"（ill-advised = 不明智的，everlasting、heartbreaking 属固化形式，不按分词规则改）；\n' +
            '4. 决定是否带连字符：作前置定语的临时复合形容词通常带连字符（mouth-watering）；' +
            '  已固化为词典词的不带（everlasting、heartbreaking、worldwide）；\n' +
            '5. 把拼好的单词代入原句，验证整句通顺、符合语境；\n' +
            '6. 输出最终单词。\n' +
            '必须只返回 JSON 对象：{"answers":[{"index":1,"word":"ill-advised"}]}，' +
            'index 从 1 开始与输入一致，word 为最终填入的完整单词（含连字符，全小写），必须覆盖所有题目，不要返回任何解释文字。';
        const user = JSON.stringify({
            items: items.map(q => ({
                index: q.index,
                sentence: compoundPromptSentence(q.sentence, q.index),
                roots: [q.roots.first, q.roots.second],
            })),
        });
        const content = await llmRequest([
            { role: 'system', content: systemPrompt },
            { role: 'user', content: user },
        ]);
        const parsed = parseLLMJson(content);
        if (!parsed || !Array.isArray(parsed.answers)) throw new Error('模型返回格式不含 answers 数组');
        return parsed.answers;
    }

    // 兜底拼合（LLM 不可用/失败时）：按常见构词模式尽力拼一个复合词。
    // 这只是保底猜测（日志会明确标注），优先级仍以模型答案为准。
    function compoundFallbackWord(roots) {
        const a = roots.first, b = roots.second;

        // 1) 已固化的合成词：直接拼接，不按分词规则变形
        const SOLID = {
            'ever+last': 'everlasting',
            'heart+break': 'heartbreaking',
            'whole+heart': 'wholehearted',
            'self+evident': 'self-evident',
        };
        const solidKey = a + '+' + b;
        if (SOLID[solidKey]) return SOLID[solidKey];

        // 2) 第二词根本身已是分词/形容词形式（-ing / -ed），直接拼
        if (/(ing|ed|en)$/.test(b)) return a + '-' + b;

        // 3) 常见"名词+现在分词"（表主动/令人…的）：名词词根 + 该动词的 -ing 形式。
        //    这里收录的都是本站同类题里出现过的搭配，命中即用 -ing，不必再猜 -ed。
        const ING_SECOND = {
            'water': 'watering', 'love': 'loving', 'break': 'breaking', 'reach': 'reaching',
            'take': 'taking', 'make': 'making', 'give': 'giving', 'have': 'having',
            'fright': 'frightening', 'think': 'thinking', 'care': 'caring', 'mean': 'meaning',
        };
        if (ING_SECOND[b]) return a + '-' + ING_SECOND[b];

        // 4) 默认：第一词根 + 连字符 + 第二词根 + ed（复合形容词最常见），
        //    注意以 e 结尾的动词只加 d（advise → advised）
        const ed = /e$/.test(b) ? b + 'd' : b + 'ed';
        return a + '-' + ed;
    }

    // 写入空盒：优先原生 setter，失败再用键盘事件逐字符输入
    async function writeCompoundAnswer(el, word) {
        if (!el || !el.isConnected) return false;
        try { el.scrollIntoView({ block: 'center' }); } catch (e) { /* ignore */ }
        realClick(el);
        try { el.focus(); } catch (e) { /* ignore */ }
        await sleep(300);

        // 通道 1：原生 setter + input/change（框架能感知）
        setNativeValue(el, word);
        await sleep(350);
        if (normWordSoft(el.value || '') === normWordSoft(word)) return true;

        // 通道 2：逐字符键盘事件
        try {
            el.value = '';
            el.dispatchEvent(new Event('input', { bubbles: true }));
            for (const ch of word) {
                el.dispatchEvent(new KeyboardEvent('keydown', { key: ch, bubbles: true }));
                el.dispatchEvent(new KeyboardEvent('keypress', { key: ch, bubbles: true }));
                el.value = (el.value || '') + ch;
                el.dispatchEvent(new Event('input', { bubbles: true }));
                el.dispatchEvent(new KeyboardEvent('keyup', { key: ch, bubbles: true }));
            }
            el.dispatchEvent(new Event('change', { bubbles: true }));
        } catch (e) { /* ignore */ }
        await sleep(300);
        return normWordSoft(el.value || '') === normWordSoft(word);
    }

    // 宽松比较：忽略大小写、连字符、空格
    function normWordSoft(s) { return String(s || '').toLowerCase().replace(/[\s\-']/g, '').trim(); }

    async function fillCompound() {
        if (!looksLikeCompoundFill()) return false;
        let items = findCompoundItems();
        for (let round = 0; round < 4 && !items.length; round++) {
            log(`等待复合词填空题加载…(${round + 1}/4)`);
            await sleep(1200);
            items = findCompoundItems();
        }
        if (!items.length) {
            log('!! 识别到复合词填空题，但未提取到题目结构');
            return true;
        }
        log(`检测到复合词构词法填空题，共 ${items.length} 题`);
        items.slice(0, 3).forEach(q => log(`  第 ${q.index} 题：词根 (${q.roots.first}, ${q.roots.second})`));

        // 取答案
        let answers = [];
        let usedFallback = false;
        const conf = loadLLMConfig();
        if (conf && conf.apiKey) {
            try {
                answers = await llmAnswerCompound(items);
                log(`大模型已返回 ${answers.length} 个答案`);
            } catch (e) {
                log('大模型作答失败:', e.message, '—— 使用兜底拼合');
                usedFallback = true;
            }
        } else {
            log('未配置大模型，使用兜底拼合');
            usedFallback = true;
        }

        // 组装计划：LLM → data-solution → 兜底拼合
        const plan = new Map();
        for (const it of items) {
            const a = (answers || []).find(x => Number(x.index) === it.index);
            let word = a && String(a.word || '').trim();
            if (!word) {
                const sol = ((it.el.getAttribute && it.el.getAttribute('data-solution')) || '').trim();
                if (sol && !/[\u4e00-\u9fa5]/.test(sol)) word = sol;
            }
            if (!word) { word = compoundFallbackWord(it.roots); usedFallback = true; }
            plan.set(it.index, word);
        }
        if (usedFallback) log('注意：部分答案为兜底拼合（未经模型确认），正确率不保证');
        log('作答计划: ' + items.map(i => `${i.index}→${plan.get(i.index)}`).join(' '));

        // 逐题填写
        let done = 0;
        for (const it of items) {
            if (isStopped()) { log('检测到停止指令，中止复合词填空'); return true; }
            const want = plan.get(it.index);
            if (!want) continue;
            const el = it.el;
            if (el && el.isConnected && normWordSoft(el.value || '') === normWordSoft(want)) { done++; continue; }

            let ok = false;
            for (let attempt = 0; attempt < 4 && !ok; attempt++) {
                if (isStopped()) return true;
                const live = findCompoundItems().find(x => x.index === it.index);
                const target = (live && live.el && live.el.isConnected) ? live.el : el;
                if (!target || !target.isConnected) break;
                ok = await writeCompoundAnswer(target, want);
                if (!ok) log(`第 ${it.index} 题：第 ${attempt + 1} 次写入未通过校验，重试`);
            }
            if (ok) {
                done++;
                log(`第 ${it.index} 题：词根 (${it.roots.first}, ${it.roots.second}) → 填入 ${want}，校验通过`);
            } else {
                log(`第 ${it.index} 题：词根 (${it.roots.first}, ${it.roots.second}) → ${want} 写入失败`);
            }
            await sleep(200);
        }

        // 终检：只读不点，找出仍为空或与目标不符的题，补填一轮（不动已正确的）
        const pending = [];
        for (const it of items) {
            const live = findCompoundItems().find(x => x.index === it.index);
            const el = live ? live.el : it.el;
            if (!el || !el.isConnected) continue;
            const want = plan.get(it.index);
            if (!want) continue;
            if (normWordSoft(el.value || '') !== normWordSoft(want)) pending.push({ it, el, want });
        }
        if (pending.length) {
            log(`终检发现 ${pending.length} 题未通过，补填一轮: ${pending.map(p => p.it.index).join(',')}`);
            for (const p of pending) {
                if (isStopped()) { log('检测到停止指令，中止补填'); return true; }
                const ok = await writeCompoundAnswer(p.el, p.want);
                if (ok) { done++; log(`第 ${p.it.index} 题：补填 ${p.want} 成功`); }
                await sleep(150);
            }
        }

        // 统计
        let remain = 0;
        const summary = [];
        const finalItems = findCompoundItems();
        for (const it of finalItems) {
            const v = (it.el && it.el.value || '').trim();
            if (!v) { remain++; summary.push(`${it.index}:空`); }
            else summary.push(`${it.index}:${v}`);
        }
        log(`复合词填空完成：成功 ${finalItems.length - remain}/${finalItems.length}，剩余空 ${remain}`);
        if (summary.length) log('最终答案显示: ' + summary.join(' '));
        return true;
    }

    /* ===================== 句子改写题（→ 已给开头 + 黄色 readonly 输入框，data-solution 存答案） ===================== */

    function findRewriteInputs() {
        const out = [];
        getDocuments().forEach(doc => {
            doc.querySelectorAll('input[type="text"], input:not([type]), textarea').forEach(inp => {
                if (inp.closest('#weauto-panel, #weauto-overlay, #weauto-ball')) return;
                const r = inp.getBoundingClientRect();
                if (r.width === 0 && r.height === 0) return;
                out.push(inp);
            });
        });
        return out.sort((a, b) => (Number(a.dataset.index) || 0) - (Number(b.dataset.index) || 0));
    }

    function looksLikeRewrite() {
        if (!findRewriteInputs().length) return false;
        return getDocuments().some(doc => {
            const t = textOf(doc.body);
            return /→/.test(t) && /Rewrite|Example/i.test(t);
        });
    }

    // 取每题上下文：原句 / 已给开头 / 空后尾部（用 textContent 爬行，避免 innerText 回流卡顿）
    function rewriteContext(inp) {
        let cont = inp.parentElement || inp;
        let node = cont;
        for (let k = 0; k < 6 && node; k++, node = node.parentElement) {
            const nInputs = node.querySelectorAll ? node.querySelectorAll('input, textarea').length : 1;
            if (nInputs > 1) break; // 已到包含多个空的题目区，停止
            cont = node;
            const tc = node.textContent || '';
            if (tc.includes('→') && tc.trim().length > 20) break;
        }
        const clone = cont.cloneNode(true);
        const ci = clone.querySelector('input, textarea');
        if (ci) ci.replaceWith(clone.ownerDocument.createTextNode(' __INPUT__ '));
        const t = textOf(clone).replace(/\s+/g, ' ').trim();
        const parts = t.split('→');
        const left = parts[0] || '';
        const right = parts.slice(1).join('→');
        const rp = right.split('__INPUT__');
        return {
            original: left.replace(/^\d+\.\s*/, '').trim(),
            start: (rp[0] || '').trim(),
            trail: (rp[1] || '').trim(),
        };
    }

    // 例句提取（textContent 廉价过滤，避免遍历全页 innerText）
    function rewriteExamples() {
        const ex = [];
        for (const doc of getDocuments()) {
            const cands = [...doc.querySelectorAll('div, span, p, b, strong, label')].filter(el => {
                const t = (el.textContent || '').trim();
                return /^Example\s*\d/i.test(t) && t.length < 40 && el.children.length <= 2;
            });
            for (const el of cands) {
                const n = el.nextElementSibling;
                if (n) {
                    const tt = (n.textContent || '').replace(/\s+/g, ' ');
                    const p = tt.split('→');
                    if (p[0] && p[1]) ex.push({ original: p[0].trim(), rewritten: p[1].trim() });
                }
                if (ex.length >= 2) break;
            }
            if (ex.length) break;
        }
        return ex.slice(0, 2);
    }

    async function llmAnswerRewrite(items, instruction, examples) {
        const systemPrompt =
            '你是英语句子改写助手。根据指令和示例，为每个已开头的改写句生成后续部分。' +
            '只返回JSON：{"answers":[{"index":1,"text":"..."}]}，text 不要重复已给的开头。';
        const content = await llmRequest([
            { role: 'system', content: systemPrompt },
            { role: 'user', content: JSON.stringify({ instruction, examples, items }) },
        ]);
        const parsed = parseLLMJson(content);
        if (!parsed || !Array.isArray(parsed.answers)) throw new Error('模型返回格式不含 answers 数组');
        return parsed.answers;
    }

    async function fillRewrite() {
        if (!looksLikeRewrite()) return false;
        const inputs = findRewriteInputs();
        log(`检测到句子改写题，共 ${inputs.length} 题`);

        let items = [], instruction = '', examples = [];
        try {
            const bodyText = getDocuments().map(d => textOf(d.body)).join(' ');
            instruction = (bodyText.match(/Rewrite[^.]*\.\s*Use the structure[^"]*"[^"]*"/i) || bodyText.match(/Rewrite[^.]*\./i) || [''])[0];
            examples = rewriteExamples();
            items = inputs.map((inp, i) => Object.assign({ index: Number(inp.dataset.index || i + 1) }, rewriteContext(inp)));
            log(`示例 ${examples.length} 组，准备作答`);
        } catch (e) {
            log('句子改写上下文提取失败:', e.message);
            return true;
        }

        let answers = [];
        const needLLM = inputs.some(inp => !((inp.getAttribute('data-solution') || '').trim()));
        const conf = loadLLMConfig();
        if (needLLM && conf && conf.apiKey) {
            log('请求大模型生成改写答案…');
            try { answers = await llmAnswerRewrite(items, instruction, examples); log(`大模型已返回 ${answers.length} 个改写答案`); }
            catch (e) { log('大模型改写失败:', e.message); }
        }

        let filled = 0;
        for (let i = 0; i < inputs.length; i++) {
            if (isStopped()) { log('检测到停止指令，中止句子改写'); return true; }
            const inp = inputs[i];
            if (!inp.isConnected) continue;
            if ((inp.value || '').trim()) { filled++; continue; }

            const sol = ((inp.getAttribute && inp.getAttribute('data-solution')) || '').trim();
            const ans = answers.find(a => Number(a.index) === Number(inp.dataset.index || i + 1));
            const text = sol || (ans && String(ans.text).trim()) || '';
            const src = sol ? 'data-solution' : '大模型';
            if (!text) { log(`第 ${i + 1} 题：无答案，跳过`); continue; }

            inp.scrollIntoView({ block: 'center' });
            try {
                realClick(inp);
                inp.focus();
                const wasRO = inp.hasAttribute('readonly');
                if (wasRO) inp.removeAttribute('readonly');
                setNativeValue(inp, text);
                if (wasRO) inp.setAttribute('readonly', '');
                await sleep(200);
                if ((inp.value || '').trim()) { filled++; log(`第 ${i + 1} 题：${src} 填入成功`); }
                else log(`第 ${i + 1} 题：填入失败`);
            } catch (e) {
                log(`第 ${i + 1} 题：写入异常(${e.message})，尝试直接赋值`);
                try { inp.value = text; inp.dispatchEvent(new Event('input', { bubbles: true })); inp.dispatchEvent(new Event('change', { bubbles: true })); } catch (e2) { /* ignore */ }
                if ((inp.value || '').trim()) { filled++; log(`第 ${i + 1} 题：直接赋值成功`); }
            }
        }
        log(`句子改写完成：成功 ${filled}/${inputs.length}`);
        return true;
    }

    /* ===================== 自由输入填空题（点击落光标、不弹选项栏，直接输入） ===================== */

    // 找可编辑的淡黄填空 input（非 readonly，区别于选词填空）
    function findFreeInputs() {
        const out = [];
        getDocuments().forEach(doc => {
            doc.querySelectorAll('input[type="text"], input:not([type]), textarea').forEach(inp => {
                if (inp.closest('#weauto-panel, #weauto-overlay, #weauto-ball')) return;
                if (inp.readOnly || inp.disabled) return;
                const r = inp.getBoundingClientRect();
                if (r.width === 0 || r.height === 0) return;
                out.push(inp);
            });
        });
        return out;
    }

    // 取某个空所在完整句子，空替换为 __idx__。
    // 向上爬到"只含本空、且文本足够长(>=40字符)"的容器，确保带上前后文，
    // 避免只取到 input 的小包裹层导致模型没有上下文而乱猜
    function sentenceFor(inp, idx) {
        let cont = inp.parentElement;
        let node = inp;
        for (let k = 0; k < 6 && node; k++, node = node.parentElement) {
            if (node.querySelectorAll && node.querySelectorAll('input, textarea').length > 1) break;
            cont = node;
            const t = (node.textContent || '').replace(/\s+/g, ' ').trim();
            if (t.length >= 40) break;
        }
        if (!cont) return '';
        const clone = cont.cloneNode(true);
        const ci = clone.querySelector('input, textarea');
        if (ci) ci.replaceWith(clone.ownerDocument.createTextNode(` __${idx}__ `));
        return textOf(clone).replace(/\s+/g, ' ').trim().slice(0, 300);
    }

    async function llmAnswerFree(items, instruction) {
        const systemPrompt =
            '你是英语语法填空专家。用户给出若干完整句子(items，含编号blank和句子sentence，空位为__编号__)和题目要求instruction。' +
            '请仔细分析每个句子的前后文语法与语义，尤其是动词/名词的固定搭配（如 work on behalf of, drop out of, for certain, stand out, participate in），' +
            '为每个空填出唯一最恰当的单词（通常是介词或副词）。不同空的答案通常不同，切勿所有空填同一个词。' +
            '只返回JSON对象 {"answers":[{"blank":1,"word":"on"},…]}，覆盖所有空，不要返回任何解释。';
        const content = await llmRequest([
            { role: 'system', content: systemPrompt },
            { role: 'user', content: JSON.stringify({ instruction, items }) },
        ]);
        const parsed = parseLLMJson(content);
        if (!parsed || !Array.isArray(parsed.answers)) throw new Error('模型返回格式不含 answers 数组');
        return parsed.answers;
    }

    async function fillFreeInput() {
        const inputs = findFreeInputs();
        if (!inputs.length) return false;

        // 点击第一个空确认不弹选项栏（落光标=自由输入）；若弹选项栏则交给其它题型
        inputs[0].scrollIntoView({ block: 'center' });
        realClick(inputs[0]);
        inputs[0].focus();
        await sleep(CFG.optionBarDelay);
        if (extractOptions(inputs[0].ownerDocument).length >= 2 || extractWordOptions(inputs[0].ownerDocument).length >= 2) return false;

        log(`检测到自由输入填空题，共 ${inputs.length} 个空`);
        const instruction = (getDocuments().map(d => textOf(d.body)).join(' ').match(/Fill in[^.]*\./i) || [''])[0];
        const items = inputs.map((inp, i) => ({ blank: i + 1, sentence: sentenceFor(inp, i + 1) }));

        let answers = [];
        const conf = loadLLMConfig();
        if (conf && conf.apiKey) {
            try {
                answers = await llmAnswerFree(items, instruction);
                log(`大模型已返回 ${answers.length} 个答案`);
                log(`句子样本: ${items[0] ? items[0].sentence.slice(0, 80) : '(空)'}`);
                const words = answers.map(a => String(a.word).toLowerCase());
                if (inputs.length > 1 && words.length && words.every(w => w === words[0])) {
                    log('警告: 所有空答案相同，疑似上下文不足，重试一次');
                    answers = await llmAnswerFree(items, instruction);
                }
            } catch (e) { log('大模型作答失败:', e.message, '—— 使用页面内置答案'); }
        } else log('未配置大模型，使用页面内置答案');

        let filled = 0;
        for (let i = 0; i < inputs.length; i++) {
            if (isStopped()) { log('检测到停止指令，中止填空'); return true; }
            const inp = inputs[i];
            if (!inp.isConnected) continue;
            if ((inp.value || '').trim()) { filled++; continue; }

            const ans = answers.find(a => Number(a.blank) === i + 1);
            const sol = ((inp.getAttribute && inp.getAttribute('data-solution')) || '').trim();
            const word = (ans && String(ans.word).trim()) || sol;
            if (!word) { log(`第 ${i + 1} 空：无答案，跳过`); continue; }

            inp.scrollIntoView({ block: 'center' });
            realClick(inp);
            inp.focus();
            setNativeValue(inp, word);
            await sleep(250);
            if ((inp.value || '').trim()) { filled++; log(`第 ${i + 1} 空：填入成功 (${inp.value})`); }
            else log(`第 ${i + 1} 空：写入失败，跳过`);
        }
        log(`自由输入填空完成：成功 ${filled}/${inputs.length}`);
        return true;
    }

    /* ===================== 段落匹配题型（Para 段落 ↔ A/B/C 陈述） ===================== */

    // 提取文章段落：[{num, text}]，按 Para 编号排序
    function extractParaBlocks() {
        for (const doc of getDocuments()) {
            const badges = [...doc.querySelectorAll('span, div, b, strong, label, a, p')].filter(el => {
                if (el.closest('#weauto-panel, #weauto-ball')) return false;
                if (el.querySelector('span, div, b, strong, label, a, p')) return false; // 只取叶子
                return /^para\.?\s*\d+$/i.test(textOf(el).trim());
            });
            if (badges.length < 2) continue;

            const map = new Map();
            badges.forEach(b => {
                b.setAttribute(PARA_BADGE_ATTR, '1');
                const num = parseInt((textOf(b).match(/\d+/) || [0])[0], 10);
                if (!num) return;
                // 向上找包含完整段落正文的容器
                let node = b.parentElement, best = '';
                for (let i = 0; i < 4 && node; i++, node = node.parentElement) {
                    const t = textOf(node).replace(/\s+/g, ' ').trim();
                    if (t.length > 60) { best = t; break; }
                }
                if (!best) return;
                const prev = map.get(num);
                if (!prev || best.length > prev.length) map.set(num, best.slice(0, 900));
            });

            const blocks = [...map.entries()]
                .map(([num, text]) => ({ num, text }))
                .sort((a, b) => a.num - b.num);
            if (blocks.length >= 2) return blocks;
        }
        return [];
    }

    // 提取选项栏中的段落选项：[{el, num, text}]
    // 真实结构（诊断确认）：<ul id="ulPart3Options" class="AnswerSheet_chooseBox para_matching_chooseBox">
    //   <li><h5>Para. 1</h5></li> …（选项文字在 h5 里，点击目标可能是 h5 或 li）
    function extractParaOptions(preferredDoc) {
        const docs = preferredDoc ? [preferredDoc, ...getDocuments().filter(d => d !== preferredDoc)] : getDocuments();
        // 答题空盒（? 盒 / 已填 Para 盒）也长得像 "Para. N"，必须排除，
        // 否则选项列表会混入题目区的空盒，导致选项栏定位错乱
        const boxSet = new Set(findQuestionBoxes());
        for (const doc of docs) {
            // 优先在选项栏容器里取（真实页面有 ulPart3Options），避免误收文章段落标记
            const scopes = [];
            const trayUl = doc.querySelector('#ulPart3Options, ul.para_matching_chooseBox, ul.AnswerSheet_chooseBox');
            if (trayUl) scopes.push(trayUl);
            scopes.push(doc);

            for (const scope of scopes) {
                const els = [...scope.querySelectorAll('h5, span, a, div, li, button')].filter(el => {
                    if (el.closest('#weauto-panel, #weauto-ball')) return false;
                    if (el.closest('[' + PARA_BADGE_ATTR + ']')) return false;   // 排除文章里的段落标记
                    if (el.hasAttribute(PARA_BADGE_ATTR)) return false;
                    if (boxSet.has(el)) return false;
                    if (el.querySelector('input, textarea, select')) return false;
                    if (!/^para\.?\s*\d+$/i.test(textOf(el).trim())) return false;
                    const r = el.getBoundingClientRect();
                    return r.width > 0 && r.height > 0;
                });
                // 只取最内层（h5 优先于它的 li 父级）
                const inner = els.filter(el => !els.some(o => o !== el && el.contains(o)));
                const seen = new Set();
                const out = [];
                inner.forEach(el => {
                    const num = parseInt((textOf(el).match(/\d+/) || [0])[0], 10);
                    if (!num || seen.has(num)) return;
                    seen.add(num);
                    // 点击目标：优先 el 本身（h5），同时记住 li 供点击升级使用
                    out.push({ el, num, text: `Para. ${num}`, li: el.closest('li') });
                });
                if (out.length >= 2) return out.sort((a, b) => a.num - b.num);
            }
        }
        return [];
    }

    async function llmAnswerMatching(blocks, items) {
        const systemPrompt =
            '你是英语段落信息匹配题（paragraph matching）答题助手。用户会给你文章段落（每段有编号 para）和若干陈述句（items，形如 {"letter":"A","text":"..."}）。' +
            '请为每个陈述选出内容最匹配的一个段落，按内容判断，不要为了不重复而牺牲准确性。' +
            '注意：同一段落可以被多条陈述选择（段落数量可能少于陈述数量，允许重复），但每个陈述都必须分配到一个段落。' +
            '你必须只返回一个JSON对象，格式：{"answers":[{"item":"A","para":7},…]}，覆盖所有陈述，不要返回任何解释。';
        const user = JSON.stringify({
            paragraphs: blocks.map(b => ({ para: b.num, text: b.text })),
            items: items.map(i => ({ letter: i.letter, text: i.text })),
        });
        const content = await llmRequest([
            { role: 'system', content: systemPrompt },
            { role: 'user', content: user },
        ]);
        const parsed = parseLLMJson(content);
        if (!parsed || !Array.isArray(parsed.answers)) throw new Error('模型返回格式不含 answers 数组');
        return parsed.answers;
    }

    // 段落分配：WE Learn 的段落匹配题允许"多条陈述对应同一个段落"
    // （10 条陈述 / 9 个段落 这种题量也证明不是一对一），所以这里只做两件事：
    //   1) 模型给了合法段落号就照用，不因"重复"去改题；
    //   2) 缺失/无效的才补一个合理的段落。
    // 旧版强行一对一，会把模型正确的答案改坏，还会让 J 变成 Para.?（无段落可填）。
    async function ensureUniqueMatching(blocks, items, answers) {
        const nums = blocks.map(b => b.num);
        const plan = new Map();
        const missing = [];
        for (const it of items) {
            const a = (answers || []).find(x => String(x.item).toUpperCase() === it.letter);
            const n = a ? Number(a.para) : NaN;
            if (nums.includes(n)) plan.set(it.letter, n);
            else missing.push(it);
        }
        if (!missing.length) return plan;

        // 缺失项：先问模型（只问这几条，省时间），失败再按顺序兜底
        const free = nums.length ? nums : [];
        if (free.length) {
            try {
                const content = await llmRequest([
                    { role: 'system', content: '你是段落匹配题助手。为未分配的陈述各选一个段落（段落可以重复使用）。只返回JSON对象 {"answers":[{"item":"A","para":7},…]}，不要解释。' },
                    { role: 'user', content: JSON.stringify({
                        paragraphs: blocks.map(b => ({ para: b.num, text: b.text })),
                        items: missing.map(i => ({ letter: i.letter, text: i.text })),
                    }) },
                ]);
                const parsed = parseLLMJson(content);
                (parsed.answers || []).forEach(a => {
                    const letter = String(a.item).toUpperCase();
                    const n = Number(a.para);
                    if (free.includes(n) && !plan.has(letter)) plan.set(letter, n);
                });
            } catch (e) { /* 请求失败就走兜底分配 */ }
        }
        // 兜底：轮流分配段落，保证每条陈述都有段落可填
        let k = 0;
        for (const it of missing) {
            if (plan.has(it.letter) || !free.length) continue;
            const n = free[k % free.length];
            k++;
            plan.set(it.letter, n);
            log(`第 ${it.letter} 项：兜底分配 → Para. ${n}`);
        }
        return plan;
    }

    // 读取空盒当前值（input 用 value，其它用文本）
    function getVal(el) {
        if (!el) return '';
        return el.tagName === 'INPUT' ? (el.value || '').trim() : textOf(el).trim();
    }

    // 注意：这里原本有一个 dedupMatchingBoxes（直接改写空盒文字来"查重"）。
    // 它只改界面、不进站点内部答案，正是"图表都填满了但提交仍提示还有N题未完成"的根源，
    // 现已移除：答案只能靠真实点击底部选项栏里的段落来登记（见 selectParaForItem）。

    // 页面对该空给出的参考答案（data-solution 形如 "Para.7"）
    function blankParaSolution(el) {
        const s = el.getAttribute && el.getAttribute('data-solution');
        if (!s) return null;
        const m = s.match(/(\d+)/);
        return m ? { num: parseInt(m[1], 10), text: `Para. ${parseInt(m[1], 10)}` } : null;
    }

    // 在陈述句附近找对应的空：优先 input，其次"?"盒子，最后空的小盒子
    function findBlankNear(el) {
        let node = el;
        for (let k = 0; k < 5 && node; k++, node = node.parentElement) {
            if (node.closest && node.closest('#weauto-panel, #weauto-ball')) return null;
            // 守卫：爬进底部选项栏/文章容器（含多个 Para 标记）时停止，
            // 避免把选项栏的 Para 按钮误认成"已填的空"
            const nt = (node.textContent || '').replace(/\s+/g, ' ');
            if ((nt.match(/para\.?\s*\d+/gi) || []).length >= 2) return null;
            // 输入框
            const inp = node.querySelector && node.querySelector('input[type="text"], input[type="search"], input:not([type])');
            if (inp) {
                const r = inp.getBoundingClientRect();
                if (r.width > 0 && r.height > 0) return inp;
            }
            // 中间带 "?" 的空盒子（淡蓝色条形空，标签不限）
            const q = [...node.querySelectorAll('*')].find(x => {
                if (x.children.length) return false;
                const t = (x.textContent || '').trim();
                if (t !== '?' && t !== '？') return false;
                const r = x.getBoundingClientRect();
                return r.width > 0 && r.height > 0;
            });
            if (q) return q;
            // 已填答案的空盒子（显示 "Para. N" 的小框，便于续跑识别）
            const filled = [...node.querySelectorAll('*')].find(x => {
                if (x.children.length) return false;
                const v = x.tagName === 'INPUT' ? (x.value || '') : (x.textContent || '');
                if (!/^\s*para\.?\s*\d+\s*$/i.test(v)) return false;
                const r = x.getBoundingClientRect();
                return r.width > 0 && r.height > 0;
            });
            if (filled) return filled;
        }
        return null;
    }

    // 找页面上所有答题空盒（"?" 淡蓝盒 + 已填的 "Para. N" 盒），按文档+视觉顺序排序。
    // 已填盒只在 ? 盒所在区域内找（排除文章段落标记与底部选项栏），
    // 保证续跑/部分已填时按顺序赋字母（A/B/C…）依然稳定。
    function findQuestionBoxes() {
        const docs = getDocuments();
        const q = [];
        docs.forEach((doc, di) => {
            const els = [...doc.querySelectorAll('*')].filter(el => {
                if (el.closest('#weauto-panel, #weauto-ball')) return false;
                if (el.querySelector('input, textarea, select')) return false;
                const t = (el.textContent || '').trim();
                if (t !== '?' && t !== '？') return false;
                const r = el.getBoundingClientRect();
                return r.width > 0 && r.height > 0;
            });
            // 兼容 input 形态的空盒（value/placeholder 为 ?）
            doc.querySelectorAll('input').forEach(inp => {
                if (inp.closest('#weauto-panel, #weauto-ball')) return;
                const v = (inp.value || inp.placeholder || '').trim();
                if (v !== '?' && v !== '？') return;
                const r = inp.getBoundingClientRect();
                if (r.width > 0 && r.height > 0) els.push(inp);
            });
            const inner = els.filter(el => !els.some(o => o !== el && el.contains(o)));
            inner.forEach(el => q.push({ el, top: el.getBoundingClientRect().top, di }));
        });
        const filled = [];
        // 已填的 "Para. N" 盒：全文档扫描，但排除文章段落标记与底部选项栏
        // （它们的祖先容器含大量 Para 标记，或带 Previous/Next 按钮）
        docs.forEach((doc, di) => {
            [...doc.querySelectorAll('*')].forEach(el => {
                if (el.closest('#weauto-panel, #weauto-ball')) return;
                if (el.children.length) return;
                const t = (el.textContent || '').trim();
                if (!/^para\.?\s*\d+$/i.test(t)) return;
                const r = el.getBoundingClientRect();
                if (r.width === 0 || r.height === 0) return;
                let row2 = el;
                for (let k = 0; k < 5 && row2; k++, row2 = row2.parentElement) {
                    if ((row2.textContent || '').replace(/\s+/g, ' ').trim().length > 25) break;
                }
                const rt2 = row2 ? (row2.textContent || '').replace(/\s+/g, ' ').trim() : '';
                if (rt2.length < 25 || rt2.length > 400) return;
                // 判别"陈述行"：已填盒所在行带 "A." 陈述字母（真实页面），
                // 或同容器内还有 ? 盒（字母为伪元素的页面）；文章段/选项栏行两者都不满足
                const hasLetter = /(?:^|\s)[A-Z]\.\s*(?![A-Z]\.)\S/.test(rt2);
                let hasQ = false;
                // 只看行容器及其父容器（题目列表层），不能爬到 body，
                // 否则选项栏按钮会因"页面别处有 ? 盒"被误收
                for (let n = row2, k = 0; k < 2 && n && !hasQ; k++, n = n.parentElement) {
                    hasQ = [...n.querySelectorAll('*')].some(x => !x.children.length && /^(\?|？)$/.test((x.textContent || '').trim()));
                }
                if (!hasLetter && !hasQ) return;
                if ((rt2.match(/para\.?\s*\d+/gi) || []).length >= 2) return;
                if (/previous|next/i.test(rt2)) return;
                filled.push({ el, top: r.top, di });
            });
        });
        return q.concat(filled).sort((a, b) => a.di - b.di || a.top - b.top).map(x => x.el);
    }

    // 提取匹配项，三策略互补：
    //  A：先按 WeLearn 真实结构取 .matching_subject（诊断确认：li > div.matching_subject
    //     > span.matching_bg("Para. N"/"?") + span.unittestresult > input + span###.item 字母）
    //  B：? 空盒锚定向上找行容器（结构差异时的兜底）
    //  C：整行文本 "A. 陈述" / 字母单独成节点（最末兜底）
    function findMatchItems() {
        const byLetter = new Map();
        const consider = (letter, text, rowEl, blank) => {
            const prev = byLetter.get(letter);
            // 同一陈述在"题目区"和"底部选项详情区"可能出现两次，优先保留带空盒子的那个
            if (!prev || (!prev.blank && blank)) byLetter.set(letter, { letter, text, el: rowEl, blank });
        };
        // 去掉行首的 "?" 空盒 / 已填的 "Para. N"，露出 "A. 陈述" 本体
        const stripPrefix = (t) => t.replace(/^(?:\?|？|para\.?\s*\d+)\s*/i, '').trim();
        const norm = (el) => (el.textContent || '').replace(/\s+/g, ' ').trim();

        // 策略A：WeLearn 段落匹配的标准结构
        // <li><div class="matching_subject" data-id="task_2_1">
        //   <span class="matching_bg" data-itemtype="matching_click">Para. 2 | ?</span>
        //   <span class="unittestresult"><input type="text" readonly>…<span class="item">A</span></span>
        //   <span class="subject_text">陈述原文</span></div></li>
        for (const doc of getDocuments()) {
            const subjects = doc.querySelectorAll('.matching_subject');
            if (subjects.length < 2) continue;
            [...subjects].forEach(sub => {
                if (sub.closest('#weauto-panel, #weauto-ball')) return;
                const r = sub.getBoundingClientRect();
                if (r.width <= 0 || r.height <= 0) return;
                // 字母：优先 .unittestresult 里的 .item（真实页面是 <span id="A" class="item">A</span>）
                let letter = null;
                const itemNode = sub.querySelector('.unittestresult .item, .item');
                if (itemNode) letter = normSpace(itemNode.textContent).replace(/[.。\s]/g, '').toUpperCase();
                if (!letter || letter.length !== 1 || !/[A-Z]/.test(letter)) letter = null;
                // 空盒：优先 matching_bg（"?", 未答）或 data-itemtype=matching_click 的 span
                const bg = sub.querySelector('.matching_bg[data-itemtype="matching_click"], .matching_bg') ||
                    sub.querySelector('[data-itemtype="matching_click"]');
                // 陈述原文：去掉空盒与字母后的文字
                let text = normSpace(sub.textContent);
                const bgText = bg ? normSpace(bg.textContent) : '';
                if (!letter) {
                    const m = text.match(/(?:^|\s)([A-Z])\.\s*/) || text.match(/\b([A-Z])\b\s*$/);
                    if (m) letter = m[1];
                }
                if (bgText) text = text.replace(bgText, ' ');
                if (!letter) return;
                // 去掉陈述前面的题号前缀（"A." "A. " "AA. " 等）与结尾残留的字母
                text = stripPrefix(text)
                    .replace(new RegExp('^(?:' + letter + ')\\s*\\.?\\s*(?:' + letter + '\\s*\\.\\s*)?', 'i'), '')
                    .replace(new RegExp('(?:^|\\s)' + letter + '\\.?\\s*$'), '')
                    .trim();
                if (text.length < 8) return;
                consider(letter, text.slice(0, 400), sub, bg || null);
            });
        }
        if (byLetter.size >= 2) return [...byLetter.values()].sort((a, b) => a.letter.localeCompare(b.letter));

        // 策略B：? 空盒锚定
        findQuestionBoxes().forEach((box, idx) => {
            let row = box;
            for (let k = 0; k < 5 && row; k++, row = row.parentElement) {
                if (norm(row).length > 25) break;
            }
            if (!row) return;
            const t = stripPrefix(norm(row));
            const m = t.match(/^([A-Z])\.\s*(.+)$/);
            const letter = m ? m[1] : String.fromCharCode(65 + idx);
            const text = (m ? m[2] : t).trim();
            if (text.length < 8 || text.length > 400) return;
            consider(letter, text, row, box);
        });

        for (const doc of getDocuments()) {
            // 策略B：容器整体文本即 "A. 陈述"（取最内层，避免父容器重复）
            const rows = [...doc.querySelectorAll('span, div, p, li, td, tr, label, a, section')].filter(el => {
                if (el.closest('#weauto-panel, #weauto-ball')) return false;
                const t = stripPrefix(norm(el));
                if (!/^[A-Z]\.\s*\S+/.test(t) || t.length > 400) return false;
                const r = el.getBoundingClientRect();
                return r.width > 0 && r.height > 0;
            });
            const inner = rows.filter(el => !rows.some(o => o !== el && el.contains(o)));
            for (const el of inner) {
                const t = stripPrefix(norm(el));
                const m = t.match(/^([A-Z])\.\s*(.+)$/);
                if (!m || m[2].trim().length < 8) continue;
                consider(m[1], m[2].trim(), el, findBlankNear(el));
            }

            // 策略C：字母单独成节点（"A."），向上找包含陈述句的行容器
            const labels = [...doc.querySelectorAll('span, div, b, strong, label, td, a, em, i, p')].filter(el => {
                if (el.closest('#weauto-panel, #weauto-ball')) return false;
                if (el.children.length) return false;
                if (!/^[A-Z]\.$/.test((el.textContent || '').replace(/\s+/g, ' ').trim())) return false;
                const r = el.getBoundingClientRect();
                return r.width > 0 && r.height > 0;
            });
            for (const lab of labels) {
                let row = lab.parentElement;
                for (let k = 0; k < 4 && row; k++, row = row.parentElement) {
                    if (norm(row).length > 20) break;
                }
                if (!row) continue;
                const t = stripPrefix(norm(row));
                const m = t.match(/^([A-Z])\.\s*(.+)$/);
                if (!m || m[2].trim().length < 8 || t.length > 400) continue;
                consider(m[1], m[2].trim(), row, findBlankNear(row));
            }
        }
        return [...byLetter.values()].sort((a, b) => a.letter.localeCompare(b.letter));
    }

    // 提取失败时的诊断：把 ? 盒数量与疑似陈述节点的真实 HTML  dump 进日志，便于定位 DOM 差异
    function dumpMatchingDebug() {
        log('!! 诊断: ?空盒数量=' + findQuestionBoxes().length);
        let n = 0;
        for (const doc of getDocuments()) {
            for (const el of doc.querySelectorAll('*')) {
                if (n >= 3) break;
                const t = (el.textContent || '').replace(/\s+/g, ' ').trim();
                if (el.children.length <= 3 && /^[A-Z]\.\s*\S+/.test(t) && t.length > 10 && t.length < 300) {
                    log('!! 诊断陈述节点: ' + (el.outerHTML || '').replace(/\s+/g, ' ').slice(0, 220));
                    n++;
                }
            }
        }
        if (!n) log('!! 诊断: 页面中未找到任何 "A. 陈述" 形态节点，请检查练习是否完全加载');
    }

    // 段落匹配卡住时的现场诊断：把空盒、选项栏、选中态的真实结构写进日志
    function dumpMatchState(tag) {
        const clip = (s, n) => (s || '').replace(/\s+/g, ' ').slice(0, n || 240);
        log(`---- 诊断(${tag}) ----`);
        const boxes = findMatchItems().filter(i => i.blank);
        log(`诊断: 陈述 ${boxes.length} 条，空盒 ${boxes.length} 个`);
        boxes.slice(0, 3).forEach(it => {
            const b = it.blank;
            log(`诊断 第${it.letter}项 空盒: <${b && b.tagName}> "${clip(getVal(b), 30)}" class="${b ? clip(String(b.className || ''), 60) : ''}"`);
            let row = b;
            for (let k = 0; k < 6 && row && row.parentElement; k++) row = row.parentElement;
            if (row) log(`诊断 第${it.letter}项 行容器: ${clip(row.outerHTML, 500)}`);
        });
        const opts = extractParaOptions();
        log(`诊断: 选项 ${opts.length} 个: ${opts.map(o => o.text).join(' | ').slice(0, 200)}`);
        if (opts.length >= 2) {
            log(`诊断: 选项DOM: ${clip(opts[0].el.outerHTML, 300)}`);
            log(`诊断: 选项父级: ${clip(opts[0].el.parentElement && opts[0].el.parentElement.outerHTML, 600)}`);
            const tray = getParaOptionBar();
            if (tray) {
                log(`诊断: 选项栏 letter=${tray.letter} selectedNum=${tray.selectedNum} title="${clip(tray.text, 80)}"`);
                log(`诊断: 选项栏容器: ${clip(tray.container.outerHTML, 900)}`);
            } else log('诊断: 选项栏读取失败');
        } else {
            log('诊断: 此刻页面上没有 Para 选项，选项栏可能没打开');
        }
        log('---- 诊断结束 ----');
    }

    // 文章是否处于折叠态：有 Expand/展开 按钮则点击展开，确保全部 Para 段落渲染出来
    async function ensureArticleExpanded() {
        for (const doc of getDocuments()) {
            const btns = [...doc.querySelectorAll('a, button, span, div')].filter(el => {
                if (el.closest('#weauto-panel, #weauto-ball')) return false;
                if (el.children.length > 2) return false;
                const t = textOf(el).trim().toLowerCase();
                if (!(t === 'expand' || t === '展开' || /^expand[\s^v]*$/.test(t))) return false;
                const r = el.getBoundingClientRect();
                return r.width > 0 && r.height > 0;
            });
            btns.sort((a, b) => textOf(a).length - textOf(b).length);
            if (btns.length) {
                log('检测到文章折叠，点击 Expand 展开全部段落');
                realClick(btns[0]);
                await sleep(900);
                return true;
            }
        }
        return false;
    }

    /* ---------- 底部段落选项栏：状态读取 / 选中判定 ----------
       WeLearn 只在「点陈述前的蓝盒 → 选项栏切到该陈述 → 点目标段落」这条真实点击通路里
       登记答案：登记成功后该段落变蓝底、陈述前的蓝盒显示 Para.N。
       把文字直接写进蓝盒只改界面、不进站点内部答案，提交时必然提示"还有N题未完成"，
       所以下面整套流程只靠点击登记，并用"蓝底 / 蓝盒显示 Para.N"回读校验。 */

    function normSpace(t) { return String(t || '').replace(/\s+/g, ' ').trim(); }

    // 从 "Para. 7" / "para7" / "7" 里取段落号
    function paraNumOf(v) {
        const t = normSpace(v);
        if (!t) return null;
        const m = t.match(/para\.?\s*(\d+)/i) || t.match(/^\s*(\d+)\s*$/);
        return m ? Number(m[1]) : null;
    }

    // 蓝色底（选中态）判定
    function isBlueColor(color) {
        const m = String(color || '').match(/rgba?\((\d+),\s*(\d+),\s*(\d+)(?:,\s*([\d.]+))?/);
        if (!m) return false;
        const r = +m[1], g = +m[2], b = +m[3];
        const a = m[4] === undefined ? 1 : +m[4];
        if (a < 0.05) return false;
        return b > 140 && b - r > 12 && b >= g - 4;
    }

    // 整组选项里哪个是选中态：先找蓝底那一项，没有蓝底时退回 class / aria 标记。
    // 真实结构是 <li><h5 class="">Para. N</h5></li>：选中态可能落在 h5 的 class、
    // li 的 class、或 h5 的浅蓝底色上，所以三条都要看
    function paraSelectedNum(options) {
        if (!options || !options.length) return null;
        const nodeSig = (o) => {
            const out = [];
            for (const el of [o.el, o.el.parentElement, o.el.querySelector && o.el.querySelector('h5')].filter(Boolean)) {
                const cs = getComputedStyle(el);
                out.push({
                    el,
                    bg: cs.backgroundColor,
                    bi: cs.backgroundImage || '',
                    border: cs.borderTopColor,
                    color: cs.color,
                });
            }
            return out;
        };
        const blueish = (n) => isBlueColor(n.bg) ||
            (/gradient/i.test(n.bi) && (n.bi.match(/rgba?\([^)]*\)/g) || []).some(isBlueColor));
        const blue = options.filter(o => nodeSig(o).some(blueish));
        if (blue.length === 1) return blue[0].num;
        const SEL_RE = /(^|[\s_-])(active|selected|checked|current|choosed|chosen|sel|on)([\s_-]|$)/i;
        const marked = options.filter(o => {
            const els = [o.el, o.el.parentElement, o.el.querySelector && o.el.querySelector('h5')].filter(Boolean);
            return els.some(el => {
                if (SEL_RE.test(String(el.className || ''))) return true;
                return !!(el.getAttribute && (el.getAttribute('aria-pressed') === 'true' ||
                    el.getAttribute('aria-selected') === 'true' ||
                    el.getAttribute('aria-checked') === 'true'));
            });
        });
        // class 标记常见于"只有一个被选中"的情形；多个命中说明 class 不可靠
        return marked.length === 1 ? marked[0].num : null;
    }

    // 选项的样式指纹：点击前后对比，判断视觉状态是否真的变了
    function paraStyleSig(el) {
        if (!el) return '';
        const cs = getComputedStyle(el);
        const child = el.firstElementChild ? getComputedStyle(el.firstElementChild) : null;
        return [String(el.className || ''), el.getAttribute('style') || '',
            cs.backgroundColor, cs.backgroundImage, cs.borderTopColor, cs.color, cs.boxShadow,
            child ? child.backgroundColor : '', child ? child.color : ''].join('~');
    }

    // 底部 Para 选项栏：{container, options, selectedNum, letter, text, titleEl, next, prev}
    function getParaOptionBar() {
        const options = extractParaOptions();
        if (options.length < 2) return null;
        // 选项的最近公共祖先
        let container = options[0].el;
        for (let i = 0; i < 15 && container && !options.every(o => container.contains(o.el)); i++) {
            container = container.parentElement;
        }
        if (!container) return null;

        // 选项栏顶部的"当前陈述"：只在"选项栏自身"内找。
        // 真实结构：<ul id="ulPart3Options"> 上面紧挨着一行"当前陈述"，
        // 它和选项栏是兄弟/父层关系，所以从选项的父级往上找 3 层，
        // 但必须排除整页/整片题干（文字过长），否则会把页面标题误当标题。
        let title = null;
        const optTop = Math.min(...options.map(o => o.el.getBoundingClientRect().top));
        const trayRoots = [];
        for (let root = (options[0].el.closest('ul') || container), k = 0; root && k < 4; k++, root = root.parentElement) {
            if (!root.parentElement) break;
            const doc = root.ownerDocument;
            if (root === doc.body || root === doc.documentElement) break;
            if (normSpace(root.textContent).length > 600) break;   // 整片题干/整页，不是选项栏
            trayRoots.push(root);
        }
        for (const root of trayRoots) {
            if (title) break;
            const cands = [];
            for (const el of root.querySelectorAll('span, div, p, td, li, label, a, b, strong, h1, h2, h3, h4, h5, h6')) {
                if (el.closest('#weauto-panel, #weauto-ball')) continue;
                if (options.some(o => el === o.el || el.contains(o.el))) continue;
                if (el.children.length > 3) continue;
                const t = normSpace(el.textContent);
                if (!/^[A-Z]\.\s*\S/.test(t) || t.length < 12 || t.length > 420) continue;
                const r = el.getBoundingClientRect();
                if (r.width <= 0 || r.height <= 0) continue;
                if (r.bottom > optTop + 5) continue;       // 只看选项上方
                const dist = optTop - r.bottom;
                if (dist > 160) continue;                  // 离得太远，不当标题
                cands.push({ el, text: t, letter: (t.match(/^([A-Z])\./) || [])[1], dist });
            }
            if (!cands.length) continue;
            cands.sort((a, b) => a.dist - b.dist);
            title = cands[0];
        }

        let titleText = title ? title.text : '';
        let titleLetter = title ? title.letter : null;
        // 兜底：没有独立标题元素时，用"选项之前"的那几段文字当当前陈述标题。
        // 超过 600 字符说明读到了整片题干列表/整页，不能当标题用
        if (!titleText) {
            const parts = [];
            for (const node of container.querySelectorAll('*')) {
                if (options.some(o => o.el === node || node.contains(o.el))) break;
                if (node.children.length) continue;
                const t = normSpace(node.textContent);
                if (t) parts.push(t);
            }
            const lead = normSpace(parts.join(' '));
            if (lead.length >= 12 && lead.length <= 600) {
                titleText = lead;
                const m = lead.match(/(?:^|\s)([A-Z])\.\s*(?![A-Z]\.)\S/);
                titleLetter = m ? m[1] : null;
            }
        }

        const findInScope = (scope, name) => [...scope.querySelectorAll('button, a, span, div')].find(el => {
            if (el.children.length > 1) return false;
            const x = textOf(el).trim().toLowerCase();
            return x === name && el.getBoundingClientRect().width > 0;
        }) || null;
        // Previous/Next 一般和"当前陈述"同一层，比选项网格高 1~2 级
        const findBtn = (name) => {
            let scope = container;
            for (let i = 0; i < 4 && scope; i++, scope = scope.parentElement) {
                const doc = scope.ownerDocument;
                if (!scope.parentElement || scope === (doc && doc.body)) break;
                const hit = findInScope(scope, name);
                if (hit) return hit;
            }
            return null;
        };

        return {
            container, options,
            letter: titleLetter,
            text: titleText,
            titleEl: title ? title.el : null,
            selectedNum: paraSelectedNum(options),
            next: findBtn('next'), prev: findBtn('previous'),
        };
    }

    // 选项栏此刻是否正显示这条陈述（标题文字优先，其次字母）
    function trayShowsItem(tray, item) {
        if (!tray) return false;
        const want = normSpace(item.text);
        if (tray.text && want) {
            if (want.length >= 10 && tray.text.includes(want.slice(0, Math.min(40, want.length)))) return true;
            const head = want.slice(0, 20);
            if (head.length >= 10 && tray.text.includes(head)) return true;
        }
        return !!(tray.letter && tray.letter === item.letter);
    }

    // 陈述行里的空盒（未答时是「?」，已答时显示 "Para. N"）
    function matchSlotOf(item) {
        const f = findMatchItems().find(x => x.letter === item.letter);
        return (f && f.blank && f.blank.isConnected) ? f.blank : (item.blank || null);
    }
    function slotValueOf(item) {
        const b = matchSlotOf(item);
        return b && b.isConnected ? getVal(b) : '';
    }

    // 能激活该陈述选项栏的点击目标。
    // 真实结构（诊断 + 视频确认）：<li><div class="matching_subject">
    //   <span class="matching_bg" data-itemtype="matching_click">?|Para. N</span> …
    // 手工操作就是"点这个蓝色空盒"，所以蓝盒本身必须是第一个目标；
    // 其后补 .matching_subject 与 li，兼容事件绑在外层的情况。
    function matchClickTargets(boxEl, letter) {
        const out = [];
        if (boxEl && boxEl.isConnected) out.push(boxEl);
        if (boxEl && boxEl.isConnected) {
            const subj = boxEl.closest('.matching_subject');
            if (subj && subj !== boxEl) out.push(subj);
            const li = boxEl.closest('li');
            if (li && li !== boxEl && li !== subj) out.push(li);
        }
        // 行内字母（"A." / "B."）：部分模板把点击绑在字母上
        const scope = (boxEl && boxEl.closest('.matching_subject, li')) || null;
        if (scope) {
            const lab = [...scope.querySelectorAll('span, b, strong, label, em, i, div, a')]
                .find(x => !x.children.length && normSpace(textOf(x)).replace(/[.。]$/, '') === letter);
            if (lab && lab !== boxEl) out.push(lab);
        }
        return out.filter((el, i, arr) => el && arr.indexOf(el) === i);
    }

    // 把底部选项栏打开，并尽量确认打开后显示的就是本题。
    // 只看"有没有选项"是不够的：选项栏可能停在别的陈述上，那样接下来点的答案会串题。
    // 返回 'same'（确认是本题）/ 'unknown'（打开了但读不出标题）/ 'other'（打开了但不是本题）/ 'closed'
    async function openParaTray(item, boxEl) {
        const evalTray = () => {
            const tray = getParaOptionBar();
            if (!tray) return 'closed';
            if (trayShowsItem(tray, item)) return 'same';
            if (!tray.letter) return 'unknown';
            return 'other';
        };
        const st0 = evalTray();
        if (st0 === 'same') return st0;

        for (const t of matchClickTargets(boxEl || matchSlotOf(item), item.letter)) {
            if (isStopped()) return 'closed';
            try { t.scrollIntoView({ block: 'center', inline: 'nearest' }); } catch (e) { /* ignore */ }
            realClick(t);
            if (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA') {
                try { t.focus({ preventScroll: true }); } catch (e) { /* ignore */ }
            }
            for (let w = 0; w < 6; w++) {
                await sleep(150);
                const st = evalTray();
                if (st === 'same') return st;
            }
        }
        return evalTray();
    }

    // 让选项栏切换到指定陈述：
    // 点该陈述自己的蓝盒 → 行内 h5 → 字母 → 整行；都不行时用 Previous/Next 走一步再校验。
    // 每点一下就立刻回读状态再决定下一步（不盲点、不长时间空等），这是速度的关键
    async function activateMatchItem(item) {
        const liveItem = () => findMatchItems().find(x => x.letter === item.letter) || item;
        // 选项栏状态：closed=没打开 / same=正显示本条陈述 / unknown=打开了但读不出标题 / other=显示的是别的陈述
        const state = () => {
            const tray = getParaOptionBar();
            if (!tray) return 'closed';
            if (trayShowsItem(tray, item)) return 'same';
            if (!tray.letter && !tray.text) return 'unknown';
            return 'other';
        };
        const st0 = state();
        if (st0 === 'same') return true;
        // 注意：不能用"unknown 即当作已切到本题"——页面标题也算标题文本，
        // 会把"其实还停在别的题"误判成已切换。unknown 只在"这次点击把关闭的选项栏打开"时才采信。

        for (let attempt = 0; attempt < 3; attempt++) {
            if (isStopped()) return false;
            const it = liveItem();
            const box = (it.blank && it.blank.isConnected) ? it.blank : null;
            if (!box) return false;
            const wasClosed = state() === 'closed';
            const targets = matchClickTargets(box, it.letter);
            for (let ti = 0; ti < targets.length; ti++) {
                if (isStopped()) return false;
                const t = targets[ti];
                try { t.scrollIntoView({ block: 'center', inline: 'nearest' }); } catch (e) { /* ignore */ }
                realClick(t);
                if (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA') {
                    try { t.focus({ preventScroll: true }); } catch (e) { /* ignore */ }
                }
                // 轮询等待状态变化（最多 ~700ms，一变化就走）
                for (let w = 0; w < 7; w++) {
                    await sleep(100);
                    const s = state();
                    if (s === 'same') return true;
                    // 只有"点到的是本题自己的空盒"时，unknown 才可信（选项栏由这次点击打开）
                    if (s === 'unknown' && ti === 0 && wasClosed) return true;
                }
            }
            // 选项栏已打开但停在邻近陈述：走一步后立即校验
            const tray = getParaOptionBar();
            if (tray && tray.letter) {
                const order = findMatchItems().map(x => x.letter);
                const cur = order.indexOf(tray.letter), want = order.indexOf(item.letter);
                if (cur >= 0 && want >= 0 && cur !== want && Math.abs(want - cur) <= 2) {
                    const btn = want > cur ? tray.next : tray.prev;
                    if (btn) {
                        realClick(btn);
                        for (let w = 0; w < 5; w++) {
                            await sleep(100);
                            if (state() === 'same') return true;
                        }
                    }
                }
            }
        }
        return state() === 'same';
    }

    // 仅对 input 形态的空盒兜底（正常页面是 h5/span 盒子，写文字不会登记到站点）
    async function setInputSlotValue(box, text) {
        if (!box || box.tagName !== 'INPUT') return false;
        box.removeAttribute('readonly');
        setNativeValue(box, text);
        await sleep(300);
        return paraNumOf(box.value || '') === paraNumOf(text);
    }

    // 给一条陈述选中指定段落：先确保选项栏显示该陈述，再点目标段落并回读校验。
    // 返回 true = 已确认登记（蓝盒显示 Para.N，或选项栏里该段落变蓝底）
    // force=true 时不采信"蓝盒上已经显示 Para.N"（这种字样可能是旧版脚本直接写进去的假象），
    // 仍然去看站点自己的选项栏选中状态
    async function selectParaForItem(item, targetNum, force) {
        const tag = `第 ${item.letter} 项`;
        if (!targetNum) { log(`${tag}：没有可用段落号，跳过`); return false; }

        if (!(await activateMatchItem(item))) log(`${tag}：选项栏未能确认切到该陈述，继续尝试点选`);

        // 点之前各陈述的空盒内容快照：用来识别"这一下是否把答案记到了别的陈述上"
        const snapshot = () => findMatchItems().map(x => x.letter + ':' + (paraNumOf(slotValueOf(x)) || ''));
        const beforeNums = new Set(snapshot());
        const slotBeforeVal = slotValueOf(item);

        // 把某条陈述还原成点击前的样子（用来撤销串题）
        const revertSlot = async (other) => {
            const want = revertTo.get(other.letter);
            if (!want) return;
            await selectParaForItem(other, want, true);
        };
        const revertTo = new Map();
        findMatchItems().forEach(x => {
            const n = paraNumOf(slotValueOf(x));
            if (n) revertTo.set(x.letter, n);
        });

        for (let attempt = 0; attempt < 4; attempt++) {
            if (isStopped()) return false;
            // 蓝盒已显示目标段落 → 站点已登记，直接算成功
            if (!force && paraNumOf(slotValueOf(item)) === targetNum) return true;

            let tray = getParaOptionBar();
            if (!tray) {
                // 选项栏可能点完自动收起：重新点开；还必须确认打开后显示的就是本题，
                // 否则接下来点的选项会记到别的陈述上
                const opened = await openParaTray(item, matchSlotOf(item));
                if (opened === 'closed') {
                    log(`${tag}：选项栏未出现，无法选择`);
                    return false;
                }
                tray = getParaOptionBar();
                if (!tray) return false;
                if (!trayShowsItem(tray, item)) {
                    if (!(await activateMatchItem(item))) {
                        log(`${tag}：选项栏停在 ${tray.letter || '?'}，无法切回本项，跳过以免填错题`);
                        return false;
                    }
                    tray = getParaOptionBar();
                    if (!tray || !trayShowsItem(tray, item)) {
                        log(`${tag}：选项栏仍未显示本项，跳过以免填错题`);
                        return false;
                    }
                }
            }
            const opt = tray.options.find(o => o.num === targetNum);
            if (!opt) { log(`${tag}：选项栏中没有 Para. ${targetNum}`); return false; }

            const shows = trayShowsItem(tray, item);
            // 站点自己的选项栏已显示目标段落为选中态：直接成功（不要重复点，避免把它点回未选）
            if (shows && tray.selectedNum === targetNum) {
                log(`${tag}：${force ? '已确认选中' : '已选中'} ${opt.text}`);
                return true;
            }
            // 选项栏停的不是本题：点选项只会把答案记到别的陈述上，必须先切回本题
            if (!shows) {
                if (attempt === 0) {
                    log(`${tag}：选项栏当前=${tray.letter || '?'}，与本项不符，先切回本项`);
                }
                if (!(await activateMatchItem(item))) {
                    log(`${tag}：无法让选项栏切到本陈述，跳过以免填错题`);
                    break;
                }
                tray = getParaOptionBar();
                const o0 = tray && tray.options.find(o => o.num === targetNum);
                if (!o0) continue;
                if (trayShowsItem(tray, item) && tray.selectedNum === targetNum) {
                    log(`${tag}：填入成功 (${o0.text})`);
                    return true;
                }
            }

            const before = paraStyleSig(opt.el);
            // 点之前最后再确认一次：站点可能在读状态的间隙自动跳题，
            // 这一下如果点下去，答案就记到别的陈述上了。
            // 必须重新取选项栏与选项节点——页面重渲染后旧节点虽 isConnected=true，
            // 但已不属于当前显示的这条陈述，点它会点错题。
            const trayNow = getParaOptionBar();
            if (!trayNow || !trayShowsItem(trayNow, item)) {
                log(`${tag}：选项栏在点击前跳走了（现为 ${trayNow ? trayNow.letter || '?' : '关闭'}），重新切回本项`);
                if (!(await activateMatchItem(item))) continue;
                continue;   // 下一轮重新取选项、重新判定
            }
            const optNow = trayNow.options.find(o => o.num === targetNum);
            if (!optNow) continue;
            // 只点一次。重复点同一个选项会把"已选"点回"未选"或改到别的陈述上，
            // 所以每次尝试只发一次点击，没生效就下一轮重新取状态再决定。
            try { optNow.el.scrollIntoView({ block: 'center', inline: 'nearest' }); } catch (e) { /* ignore */ }
            if (attempt === 0) {
                realClick(optNow.el);
            } else if (attempt === 1) {
                // 可能被覆盖层挡住：按坐标命中最上层元素再点
                const r = optNow.el.getBoundingClientRect();
                let top = null;
                try { top = optNow.el.ownerDocument.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2); } catch (e) { /* ignore */ }
                realClick(top || optNow.el);
            } else {
                // 事件可能绑在 li 上：点它的父级 li
                const li = optNow.li || optNow.el.closest('li');
                realClick(li && li !== optNow.el ? li : optNow.el);
            }

            // 点击后轮询回读（最多 ~1s，一确认就走，不空等）。
            // 站点登记成功后常常会**自动收起选项栏或跳到下一条陈述**，
            // 所以先读"陈述前的蓝盒有没有显示 Para.N"，这是最可靠的登记证据。
            for (let w = 0; w < 10; w++) {
                await sleep(100);
                const v = slotValueOf(item);
                if (paraNumOf(v) === targetNum) {
                    log(`${tag}：填入成功 (${normSpace(v)})`);
                    return true;
                }
                const t2 = getParaOptionBar();
                if (t2 && trayShowsItem(t2, item) && t2.selectedNum === targetNum) {
                    log(`${tag}：填入成功 (Para. ${targetNum}，已变蓝底)`);
                    return true;
                }
            }
            // 再确认一次蓝盒（站点可能延迟刷新文字）
            if (paraNumOf(slotValueOf(item)) === targetNum) {
                log(`${tag}：填入成功 (Para. ${targetNum})`);
                return true;
            }
            const tNow = getParaOptionBar() || tray;
            const oNow = tNow.options.find(o => o.num === targetNum);
            if (oNow && paraStyleSig(oNow.el) !== before) {
                await sleep(250);
                if (paraNumOf(slotValueOf(item)) === targetNum) { log(`${tag}：填入成功 (Para. ${targetNum})`); return true; }
            }
            // 安全检查：这一次点击有没有把答案记到别的陈述上？
            // 站点在点完会自动把选项栏跳到下一条未答陈述，一旦动作与读取错位就会串题，
            // 串题后必须把错记的那条改回来，否则后面每一题都会错位。
            const clobbered = findMatchItems().find(o => o.letter !== item.letter &&
                paraNumOf(slotValueOf(o)) === targetNum &&
                !beforeNums.has(o.letter + ':' + targetNum));
            if (clobbered && paraNumOf(slotBeforeVal) !== targetNum) {
                log(`${tag}：检测到答案串到了第 ${clobbered.letter} 项，正在改回`);
                await revertSlot(clobbered);
            }
            log(`${tag}：第 ${attempt + 1} 次点击未生效，重试`);
        }

        // 最后兜底：只有 input 形态的空盒才允许写值（对 h5/span 盒子写文字不会登记）
        if (await setInputSlotValue(matchSlotOf(item), `Para. ${targetNum}`)) {
            log(`${tag}：输入框形态的空盒已写入 Para. ${targetNum}`);
            return true;
        }
        log(`${tag}：多次点击后仍未选中 Para. ${targetNum}`);
        // 首次卡住的题才 dump，避免日志被刷屏
        if (!window.__weautoDumped) { window.__weautoDumped = true; dumpMatchState(`${tag} 卡住`); }
        return false;
    }

    // 题型快速判定：文章带 Para 标记，或「?」空盒 + 页面提示文字（文章折叠时也能识别）
    function looksLikeMatching() {
        if (extractParaBlocks().length >= 2) return true;
        const withBlank = findMatchItems().filter(i => i.blank);
        if (withBlank.length < 2) return false;
        return getDocuments().some(doc => /请点击.{0,6}按钮或者题干开始答题/.test(textOf(doc.body)));
    }

    async function fillMatching() {
        // 文章可能折叠（Expand/Retract 开关），先展开再提取段落
        await ensureArticleExpanded();
        let blocks = extractParaBlocks();
        let items = findMatchItems();
        // 陈述项可能异步加载，未提取到时重试等待
        for (let round = 0; round < 6 && items.length < 2; round++) {
            log(`等待陈述项加载…(${round + 1}/6)`);
            await sleep(1200);
            items = findMatchItems();
            blocks = extractParaBlocks();
        }
        if (items.length < 2) {
            dumpMatchingDebug();
            return false;
        }

        const withBlank = items.filter(it => it.blank);
        log(`检测到段落匹配题型：文章段落 ${blocks.length} 个，匹配项 ${items.length} 个（其中找到空 ${withBlank.length} 个）`);
        if (!withBlank.length) {
            dumpMatchingDebug();
            log('!! 未找到陈述句旁的"?"空盒子，无法作答');
            return true; // 确认是匹配题但没找到空，避免走通用兜底乱点
        }
        if (blocks.length < 2) {
            log('警告：未提取到文章段落（可能折叠或加载不全），优先使用页面内置答案');
        }

        // 先把一条陈述的选项栏打开：既确认选项栏可操作，也读出全部可选项
        const probe = withBlank.find(it => paraNumOf(slotValueOf(it)) == null) || withBlank[0];
        if ((await openParaTray(probe, probe.blank)) === 'closed') {
            log('警告：暂时没识别到段落选项栏，仍按逐题流程尝试打开');
        }
        let paraOpts = extractParaOptions();
        if (paraOpts.length >= 2) log(`可选项 ${paraOpts.length} 个: ${paraOpts.map(o => o.text).join(' | ').slice(0, 160)}`);

        // 大模型匹配
        let answers = [];
        const conf = loadLLMConfig();
        if (conf && conf.apiKey && blocks.length) {
            try {
                answers = await llmAnswerMatching(blocks, items);
                log(`大模型已返回 ${answers.length} 个匹配结果`);
            } catch (e) {
                log('大模型作答失败:', e.message, '—— 使用页面内置答案');
            }
        } else {
            log('未配置大模型，使用页面内置答案');
        }

        // 段落分配：允许同一段落被多条陈述使用，只要每条陈述都有段落
        const plan = await ensureUniqueMatching(blocks, items, answers);
        log('最终分配: ' + items.map(i => `${i.letter}→Para.${plan.get(i.letter) || '?'}`).join(' '));

        // 兜底段落：计划缺失时用页面内置答案，再不行取第一个可选项
        const fallbackNum = (paraOpts[0] && paraOpts[0].num) || (blocks[0] && blocks[0].num) || 1;

        // 逐题走完整的人工流程：点陈述前的蓝盒 → 选项栏切到该陈述 → 点目标段落
        // → 回读确认该段落变蓝底 / 蓝盒显示 Para.N。
        // 关键：只通过真实点击登记答案，绝不把文字直接写进蓝盒
        //（直接写只改界面、不进站点内部答案，提交时必报"还有N题未完成"）
        const okMap = new Map();
        for (const item of withBlank) {
            if (isStopped()) { log('检测到停止指令，中止段落匹配'); return true; }
            const sol = blankParaSolution(matchSlotOf(item));
            const targetNum = plan.get(item.letter) || (sol && sol.num) || fallbackNum;
            if (!plan.has(item.letter)) plan.set(item.letter, targetNum);
            log(`第 ${item.letter} 项：目标 → Para. ${targetNum}`);
            okMap.set(item.letter, await selectParaForItem(item, targetNum));
            await sleep(250);
        }

        // 补选：只处理"蓝盒不是目标段落"或上一轮未确认的题，不动已经正确的题
        for (let round = 1; round <= 2; round++) {
            if (isStopped()) { log('检测到停止指令，中止补选'); return true; }
            const pending = withBlank.filter(it => {
                const want = plan.get(it.letter);
                return paraNumOf(slotValueOf(it)) !== want || !okMap.get(it.letter);
            });
            if (!pending.length) break;
            log(`补选第 ${round} 轮: ${pending.map(i => i.letter).join(',')}`);
            for (const it of pending) {
                if (isStopped()) { log('检测到停止指令，中止补选'); return true; }
                okMap.set(it.letter, await selectParaForItem(it, plan.get(it.letter) || fallbackNum));
                await sleep(200);
            }
        }

        // 终检：只读不点，避免把已经选好的蓝底又点掉
        lastMatchPlan = plan;   // 供提交后"还有N题未完成"时的补选使用
        let remain = 0;
        const summary = [];
        for (const it of withBlank) {
            const n = paraNumOf(slotValueOf(it));
            if (n == null) { remain++; summary.push(`${it.letter}:空`); }
            else summary.push(`${it.letter}:${n}`);
        }
        log(`段落匹配完成：成功 ${withBlank.length - remain}/${withBlank.length}，剩余未填 ${remain}`);
        log('最终答案显示: ' + summary.join(' '));
        return true;
    }

    /* ---------- 提交后兜底：页面提示"还有 N 题未完成"时逐题补选再重交 ---------- */

    // 页面上的"还有 N 题未完成，请全部完成再提交！"提示 → 返回未完成数量，识别不到返回 -1
    function incompleteHintCount() {
        for (const doc of getDocuments()) {
            const t = normSpace(textOf(doc.body));
            const m = t.match(/还有\s*(\d+)\s*题\s*未完成/);
            if (m) return Number(m[1]);
        }
        return -1;
    }

    // 提交期间盯着页面新增的提示节点：这种提示可能一闪而过，事后再读就读不到了
    let hintWatch = null;
    function startIncompleteHintWatch() {
        stopIncompleteHintWatch();
        hintWatch = { seen: incompleteHintCount(), observer: null };
        try {
            const obs = new MutationObserver(muts => {
                if (!hintWatch) return;
                for (const m of muts) {
                    const nodes = m.type === 'characterData'
                        ? [m.target && m.target.parentNode]
                        : [...(m.addedNodes || [])];
                    for (const n of nodes) {
                        const t = n && n.textContent;
                        if (!t) continue;
                        const mm = String(t).match(/还有\s*(\d+)\s*题\s*未完成/);
                        if (mm) { hintWatch.seen = Number(mm[1]); return; }
                    }
                }
            });
            for (const doc of getDocuments()) {
                if (doc.body) obs.observe(doc.body, { childList: true, subtree: true, characterData: true });
            }
            hintWatch.observer = obs;
        } catch (e) { /* 观察不到就退回直接读页面 */ }
    }
    function hintLeft() {
        const cur = incompleteHintCount();
        if (cur >= 0) return cur;
        return hintWatch && hintWatch.seen >= 0 ? hintWatch.seen : -1;
    }
    function stopIncompleteHintWatch() {
        if (hintWatch && hintWatch.observer) {
            try { hintWatch.observer.disconnect(); } catch (e) { /* ignore */ }
        }
        hintWatch = null;
    }

    // 逐题重新核对：点开陈述前的蓝盒，确认选项栏里本陈述的目标段落是选中（蓝底）状态，不是就重选。
    // 全部确认返回确认数量；仍有无法确认的返回 0（此时不再重复提交）
    async function repairMatchingSelection() {
        const plan = lastMatchPlan;
        if (!plan || !plan.size) return 0;
        const items = findMatchItems().filter(it => it.blank);
        if (!items.length) return 0;
        let fixed = 0, failed = 0;
        for (const item of items) {
            if (isStopped()) break;
            const sol = blankParaSolution(matchSlotOf(item));
            const want = plan.get(item.letter) || paraNumOf(slotValueOf(item)) || (sol && sol.num);
            // force=true：不采信蓝盒上已有的 Para.N 字样（可能是旧版脚本直接写进去的假象）
            if (!want || !(await selectParaForItem(item, want, true))) { failed++; continue; }
            fixed++;
            await sleep(150);
        }
        log(`段落匹配复核：可确认 ${fixed}/${items.length}${failed ? `，${failed} 项无法确认` : ''}`);
        return failed ? 0 : fixed;
    }

    // 划线词辨析的复核：只读判定每题是否已有选中项，没有的按计划补选。
    // 已选中的题一律不动，避免把选中态点掉。返回补选成功数（仍有失败时返回 0）
    async function repairUnderlineSelection() {
        const items = findUnderlineItems();
        if (!items.length) return 0;
        let fixed = 0, failed = 0;
        for (const it of items) {
            if (isStopped()) break;
            const cur = selectedChoiceOf(it);
            if (cur) { fixed++; continue; }
            // 没有选中项：优先沿用上一次的计划，其次用页面 data-solution
            const want = underlinePlan.get(it.index) ||
                (((it.block.getAttribute && it.block.getAttribute('data-solution')) || '').trim().toUpperCase().charAt(0)) || '';
            if (!want || !it.options.some(o => o.letter === want)) { failed++; continue; }
            if (await selectChoiceForItem(it, want)) fixed++;
            else failed++;
            await sleep(150);
        }
        log(`划线词辨析复核：可确认 ${fixed}/${items.length}${failed ? `，${failed} 项无法确认` : ''}`);
        return failed ? 0 : fixed;
    }

    /* ===================== 划线词词义辨析选择题（Choose the answer that best explains each underlined part） =====================
       页面结构（实测）：
         <div class="AnswerSheet_content">
           <ul class="AnswerSheet_chooseBox">
             <li data-refids="task_2_1">
               1. The third Silk Road Symposium for <u>Distinguished</u> Young Scholars opened on Friday...
               <ul> 或 div 里是 A/B/C/D 四个选项，每项形如 <span class="item">A</span> Outstanding
             </li>
           </ul>
         </div>
       与段落匹配一致：只有真实点击选项才会被站点登记，直接改 DOM 文本不会计入答案。 */

    const UNDERTEST_ATTR = 'data-weauto-undersel'; // 选中态兜底标记（仅用于本模块内部判定，不改站点数据）

    // 题型判定（划线词词义辨析选择题）。
    // 判据必须"双保险"，否则会把普通填空题误认成本题型：
    //   ① 页面指令文本出现 "best explains each underlined part" → 直接确认；
    //   ② 否则必须同时满足：题干里确实有"带下划线样式"的元素
    //      ＋ 存在结构化的 A/B/C/D 选项组（每组至少 2 个字母锚点）。
    // 注意：选词填空页面的空盒里有 <strong>500</strong> 这类加粗数字、
    // 以及 "B. imported" 这种 data-solution 回显，都绝不能被当成"划线 + 选项组"。
    function looksLikeUnderlineChoice() {
        for (const doc of getDocuments()) {
            const t = (doc.body && (doc.body.innerText || doc.body.textContent)) || '';
            if (/best\s+explains\s+each\s+underlined\s+part/i.test(t.replace(/\s+/g, ' '))) return true;
        }
        // 结构性佐证：必须有真正的题目块（含一整组 A-D 选项）
        const blocks = findUnderlineQuestions();
        if (!blocks.length) return false;
        return findUnderlineItems().length >= 2;
    }

    // 是否为"划线"元素：u / ins / span[style*=underline] 等，
    // 且必须在"元素自身"上带下划线样式——不能因为祖先节点有下划线就算。
    function isUnderlinedEl(el, doc) {
        if (!el || el.nodeType !== 1) return false;
        if (el.closest('#weauto-panel, #weauto-ball')) return false;
        if (el.querySelector('u, ins')) return false;          // 只取最内层
        const tag = el.tagName;
        let byTag = /^(U|INS)$/.test(tag);
        if (!byTag) {
            const st = (el.getAttribute('style') || '').replace(/\s+/g, '').toLowerCase();
            byTag = /text-decoration:[^;]*underline/.test(st) || /border-bottom:\s*[^;]*solid/.test(st);
        }
        let byClass = /underlin/i.test(String(el.className || ''));
        let byComputed = false;
        // 只有 u/ins 之外的标签才需要看计算样式；且不看 <strong>/<b> 这类纯加粗标签
        if (!byTag && !byClass && !/^(STRONG|B|I|EM|A)$/.test(tag)) {
            try {
                const view = (el.ownerDocument && el.ownerDocument.defaultView) || window;
                const cs = view.getComputedStyle(el);
                const deco = cs.textDecorationLine || cs.textDecoration || '';
                byComputed = /underline/.test(deco) && (el.textContent || '').trim().length > 0;
            } catch (e) { /* ignore */ }
        }
        if (!byTag && !byClass && !byComputed) return false;
        const txt = (el.textContent || '').trim();
        if (!txt || txt.length > 60) return false;
        if (/^[A-D]$/.test(txt)) return false;                  // 选项字母不算划线词
        if (/^\d+$/.test(txt)) return false;                    // 纯数字（如 "500"）不算划线词
        const r = el.getBoundingClientRect();
        return r.width > 0 && r.height > 0;
    }

    // 找页面上所有题块（按文档流/视觉位置排序）。
    // 不依赖某一个固定的外层 class：按"哪一层恰好包含一组 A-D 选项"来判定。
    // 重要：外层容器（包含多道题）也会"包含 ≥2 个选项字母"，必须切成单题，
    // 否则 extractChoiceOptions 会把多题的同名字母去重成一组，看起来只有 1 题。
    function findUnderlineQuestions() {
        const out = [];
        for (const doc of getDocuments()) {
            const inPanel = el => el.closest('#weauto-panel, #weauto-ball');

            // 1) 已知答题卡结构
            const known = [...doc.querySelectorAll(
                '.AnswerSheet_chooseBox > li, .AnswerSheet_content li[data-refids], li[data-refids]'
            )].filter(el => !inPanel(el) && extractChoiceOptions(el).length >= 2);

            // 2) 通用池：所有"像一道选择题"的容器（供切分与兜底使用）。
            //    这里的门槛必须比"含 ≥2 个选项字母"更严，否则会把选词填空的词库、
            //    带 data-solution 回显的填空控件误当成 A/B/C/D 选择题：
            //    · 必须恰好有 2~4 个不同字母的选项（一组选择题）；
            //    · 容器内不能有填空输入框（有 input 说明是填空题，不是选择题）；
            //    · 每个选项字母必须是"独立的小节点"（词库里的 "A. suspect" 是整串文字，不算）。
            const all = [...doc.querySelectorAll('li, div, section, article, tr, ul, ol')].filter(el => {
                if (inPanel(el)) return false;
                const r = el.getBoundingClientRect();
                if (r.width === 0 || r.height === 0) return false;
                if (looksLikeChoiceGroup(el)) return true;
                return false;
            });

            // 3) 已知结构也要切开：站点可能把整张答题卡塞进"一个" li[data-refids]，
            //    那样它同样会因为同名字母去重而看起来只有 1 题
            const pieces = [];
            for (const el of known) {
                const parts = splitIntoSingleQuestions(el, all, inPanel);
                if (parts.length > 1) pieces.push(...parts);      // 确实含多题 → 用切分结果
                else pieces.push(el);
            }

            // 4) 已知结构为空、或切分后仍然只有 1 题，但页面上明显有多组选项 → 走通用切分
            let picked = pieces;
            const needGeneric = !picked.length ||
                (picked.length < 2 && countAllAnchors('A', all, inPanel) > 1);
            if (needGeneric) {
                const split = [];
                for (const el of all) split.push(...splitIntoSingleQuestions(el, all, inPanel));
                const uniqSplit = split.filter((el, i, a) => a.indexOf(el) === i);
                // 通用切分只要拿到 ≥2 题就采信；否则保留已知结果
                if (uniqSplit.length >= 2) picked = uniqSplit;
                else if (!picked.length) picked = uniqSplit;
            }

            // 5) 去重：同一题被多个祖先命中时保留最内层
            const uniq = picked.filter(el => !picked.some(o => o !== el && el.contains(o)));
            for (const el of uniq) {
                const r = el.getBoundingClientRect();
                if (r.width === 0 && r.height === 0) continue;
                out.push(el);
            }
        }
        const docIndex = new Map();
        getDocuments().forEach((d, i) => docIndex.set(d, i));
        return out
            .map(el => ({ el, di: docIndex.get(el.ownerDocument) || 0, top: el.getBoundingClientRect().top }))
            .sort((a, b) => a.di - b.di || a.top - b.top)
            .map(x => x.el);
    }

    // 判断一个容器是否"像一个 A/B/C/D 选择题组"。
    // 这是划线词辨析的结构性判据，也是防止把填空题误认成选择题的关键闸门：
    //   · 恰好有 2~4 个不同字母、且字母必须是"独立小节点"（正文整串 "A. suspect" 不算）
    //   · 容器内没有任何输入框（有 input 就是填空题）
    //   · 选项文字不能是空的
    function looksLikeChoiceGroup(el) {
        if (!el || !el.querySelectorAll) return false;
        // 有输入框 → 这是填空题（选词/语法/复合词），绝不是选择题
        if (el.querySelector('input, textarea, select')) return false;

        const letters = new Set();
        let anchorCount = 0;
        for (const n of el.querySelectorAll('span, b, strong, i, em, a, div, li, label, p, td')) {
            if (n.children.length) continue;
            const t = (n.textContent || '').replace(/\s+/g, ' ').trim();
            // 字母节点必须是"单独一个字母"（可带一个标点），不能是 "A. suspect" 这种整串
            if (!/^[A-D]\s*[.、:：)）]?$/.test(t)) continue;
            letters.add(t.charAt(0).toUpperCase());
            anchorCount++;
        }
        if (anchorCount < 2 || letters.size < 2 || letters.size > 4) return false;

        // 选项文字不能为空：至少有两个字母后面跟着实际内容
        const opts = extractChoiceOptions(el);
        if (opts.length < 2) return false;
        const withText = opts.filter(o => String(o.text || '').replace(/[^\w]/g, '').length >= 1);
        return withText.length >= 2;
    }

    // 统计页面上"文字恰为该字母"的锚点总数（跨多个容器累加，用于判断是否还有别的题）
    function countAllAnchors(letter, containers, inPanel) {
        const seen = new Set();
        let n = 0;
        for (const c of containers) {
            if (inPanel(c)) continue;
            for (const el of c.querySelectorAll('span, b, strong, i, em, a, div, li, label, p, td')) {
                if (el.children.length || seen.has(el)) continue;
                const t = (el.textContent || '').replace(/\s+/g, ' ').trim();
                if (new RegExp('^' + letter + '\\s*[.、:：)）]?$').test(t)) { seen.add(el); n++; }
            }
        }
        return n;
    }

    // 把一个"含多组 A-D 选项"的容器切成若干"单题"元素。
    // 采用"锚点归组"：把所有选项字母按视觉位置排序，遇到 A 就开一道新题（B/C/D 归入当前题），
    // 然后取该组最后一个选项行的父级（选项列表）向上找到"同时包含题干与该选项列表"的容器。
    // 这样即使外层只有一个大容器、题目平铺排列，也能正确切成每题一块。
    function splitIntoSingleQuestions(container, allContainers, inPanel) {
        const res = [];
        if (!container || !container.querySelectorAll) return res;

        // 该容器内的所有选项字母锚点（按视觉位置排序）
        const anchors = [...container.querySelectorAll('span, b, strong, i, em, a, div, li, label, p, td')]
            .filter(el => !inPanel(el))
            .filter(el => el.children.length === 0)
            .filter(el => {
                const t = (el.textContent || '').replace(/\s+/g, ' ').trim();
                return /^[A-D]\s*[.、:：)）]?$/.test(t);
            })
            .map(el => ({ el, letter: (el.textContent || '').trim().charAt(0).toUpperCase(), top: el.getBoundingClientRect().top }))
            .sort((a, b) => a.top - b.top);
        if (anchors.length < 2) return res;

        // 按 A 切组
        const groups = [];
        let cur = null;
        for (const an of anchors) {
            if (an.letter === 'A' || !cur) { cur = [an]; groups.push(cur); }
            else cur.push(an);
        }

        for (const g of groups) {
            if (g.length < 2) continue;                    // 选项不足，跳过
            // 该组选项所在的列表容器
            const list = g[0].el.closest('ul, ol') ||
                (g[0].el.parentElement && g[0].el.parentElement.parentElement);
            if (!list) continue;
            // 向上找"包含选项列表、且只含这一组选项"的容器：
            //   每上一层都检查它里面有多少个 A 字母——多于 1 个说明已经跨题，立即回退
            let blockEl = list;
            let guard = 0;
            while (blockEl && blockEl.parentElement && guard++ < 12) {
                const parent = blockEl.parentElement;
                if (inPanel(parent) || parent === container.ownerDocument.body) break;
                const aCount = countAnchorsNamed(parent, 'A');
                if (aCount > 1) break;                     // 再往上就跨题了
                blockEl = parent;
            }
            if (extractChoiceOptions(blockEl).length >= 2) {
                res.push(blockEl);
            } else {
                // 退回：直接以选项列表的父级为题块
                const fb = list.parentElement || list;
                if (extractChoiceOptions(fb).length >= 2) res.push(fb);
            }
        }
        return res;
    }

    // 统计某容器内"文字恰为指定字母"的叶子节点个数（用于判断容器是否已跨题）
    function countAnchorsNamed(root, letter) {
        if (!root || !root.querySelectorAll) return 0;
        let n = 0;
        for (const el of root.querySelectorAll('span, b, strong, i, em, a, div, li, label, p, td')) {
            if (el.children.length) continue;
            const t = (el.textContent || '').replace(/\s+/g, ' ').trim();
            if (new RegExp('^' + letter + '\\s*[.、:：)）]?$').test(t)) n++;
        }
        return n;
    }

    // 解析题块里的 A/B/C/D 选项。
    // 关键教训：不能假设选项行文本一定是 "A. xxx" 开头——真实模板可能是
    //   <li><span class="item">A</span> <u>xxx</u></li>
    // 字母在独立节点里、正文里没有 "A." 前缀。所以这里以"字母节点"为锚点：
    //   1) 找文字恰好是 A/B/C/D（可带 . 、 )）的叶子节点；
    //   2) 向上取到只含这一个字母的"选项行"作为可点目标；
    //   3) 选项文字 = 该行文本去掉开头的字母。
    // 注意：本函数假定传进来的是"一道题"的范围。若传外层容器（包含多题），
    // 多题的同名字母会被去重成一组——那正是"10 题只识别到 1 题"的根源，
    // 所以 findUnderlineQuestions 会先把外层容器切成单题。
    function extractChoiceOptions(block) {
        if (!block || !block.querySelectorAll) return [];
        const inPanel = el => el.closest('#weauto-panel, #weauto-ball');

        // 1) 字母锚点
        const letterNodes = [...block.querySelectorAll('span, b, strong, i, em, a, div, li, label, p, td')]
            .filter(el => !inPanel(el))
            .filter(el => {
                const t = (el.textContent || '').replace(/\s+/g, ' ').trim();
                return /^[A-D]\s*[.、:：)）]?$/.test(t);
            });
        // 只保留最内层（父节点文字若也是纯字母就算了）
        const anchors = letterNodes.filter(el => !letterNodes.some(o => o !== el && el.contains(o)));

        const byLetter = new Map();
        for (const a of anchors) {
            const letter = (a.textContent || '').trim().charAt(0).toUpperCase();
            if (byLetter.has(letter)) continue;
            // 2) 向上找"选项行"：从字母节点开始，只在"这一层还没有出现第二个字母"时继续上升。
            //    一旦当前节点里出现了别的选项字母，说明已经到了选项列表层，必须停在上一步。
            let row = a;
            for (let k = 0; k < 5; k++) {
                const p = row.parentElement;
                if (!p || p === block || inPanel(p)) break;
                const pt = (p.textContent || '').replace(/\s+/g, ' ').trim();
                if (pt.length > 200) break;                       // 已经太大，到题块级了
                // 父节点里出现了"另一个选项字母"→ 不能再上升
                const letterCount = countChoiceLetters(p);
                if (letterCount >= 2) break;
                row = p;
            }
            const rowText = (row.textContent || '').replace(/\s+/g, ' ').trim();
            // 3) 去掉开头的字母（可能还带 . 、） 等标点）
            let text = rowText.replace(new RegExp('^\\s*' + letter + '\\s*[.、:：)）]?\\s*'), '').trim();
            // 若行内还有别的字母混进来（说明粒度仍偏大），退一步只取"字母之后"的文本
            if (!text || countChoiceLetters(row) >= 2) {
                const after = textAfterNode(row, a);
                if (after) text = after;
            }
            if (!text) text = rowText || letter;
            const r = row.getBoundingClientRect();
            if (r.width === 0 && r.height === 0) continue;
            // 找到"选项文字"所在的节点：优先用行内最长的、不含字母的那个文字节点
            let textEl = null;
            {
                const norm2 = s => String(s || '').replace(/\s+/g, ' ').trim();
                let best = 0;
                const walker = row.ownerDocument.createTreeWalker(row, NodeFilter.SHOW_TEXT, null);
                let tn = walker.nextNode();
                while (tn) {
                    if (tn === a || a.contains(tn)) { tn = walker.nextNode(); continue; }
                    const tv = norm2(tn.nodeValue);
                    if (tv.length > best) { best = tv.length; textEl = tn.parentElement; }
                    tn = walker.nextNode();
                }
                // 文字节点太窄（比如只有几个像素）时退回整行
                if (textEl) {
                    const tr = textEl.getBoundingClientRect();
                    if (tr.width < 8 || tr.height < 8) textEl = null;
                }
            }
            byLetter.set(letter, { letter, text: text.slice(0, 160), el: a, li: row, row, textEl });
        }

        // 兜底：没有独立字母节点时，退回"文本以 A. 开头"的行判定
        if (byLetter.size < 2) {
            const cands = [...block.querySelectorAll('li, tr, label, p, div, span')].filter(el => {
                if (inPanel(el)) return false;
                if (el.children.length > 4) return false;
                const t = (el.textContent || '').replace(/\s+/g, ' ').trim();
                if (!t || t.length > 120) return false;
                if (!/^([A-D])\s*[.、:：)）]\s*(.+)$/.test(t)) return false;
                const r = el.getBoundingClientRect();
                return r.width > 0 && r.height > 0;
            });
            const inner = cands.filter(el => !cands.some(o => o !== el && el.contains(o)));
            for (const el of inner) {
                const t = (el.textContent || '').replace(/\s+/g, ' ').trim();
                const m = t.match(/^([A-D])\s*[.、:：)）]\s*(.+)$/);
                if (!m || byLetter.has(m[1])) continue;
                const li = el.closest('li, tr, label') || el;
                byLetter.set(m[1], { letter: m[1], text: m[2].trim().slice(0, 160), el, li, row: li });
            }
        }
        // 兼容旧名
        return [...byLetter.values()].sort((a, b) => a.letter.localeCompare(b.letter));
    }

    // 统计一个子树里"独立选项字母"（A/B/C/D）的个数，用来判断容器粒度
    function countChoiceLetters(root) {
        if (!root || !root.querySelectorAll) return 0;
        let n = 0;
        for (const el of root.querySelectorAll('*')) {
            if (el.children.length) continue;
            const t = (el.textContent || '').replace(/\s+/g, ' ').trim();
            if (/^[A-D]\s*[.、:：)）]?$/.test(t)) n++;
        }
        // 字母本身也算（root 可能就是字母节点）
        const rt = (root.textContent || '').replace(/\s+/g, ' ').trim();
        if (root.children.length === 0 && /^[A-D]\s*[.、:：)）]?$/.test(rt)) n++;
        return n;
    }

    // 取某个节点之后（在 row 范围内）的文本，去掉字母本身
    function textAfterNode(row, node) {
        const parts = [];
        let started = false;
        const walker = row.ownerDocument.createTreeWalker(row, NodeFilter.SHOW_TEXT, null);
        let n = walker.nextNode();
        while (n) {
            if (node.contains(n) || n === node) { started = true; n = walker.nextNode(); continue; }
            if (started) {
                const t = (n.nodeValue || '').replace(/\s+/g, ' ').trim();
                if (t) parts.push(t);
            }
            n = walker.nextNode();
        }
        return parts.join(' ').replace(/\s+/g, ' ').trim();
    }

    // 旧名字保留，避免其它地方引用报错
    function parseChoiceOptions(block) { return extractChoiceOptions(block); }

    // 提取单题的句子原文与划线词。
    // 优先在题块内部取；若题块只含选项（题干在兄弟节点里），就向前找最近的题干元素。
    function underlineTextOf(block, opts) {
        opts = opts || extractChoiceOptions(block);
        const optRowSet = new Set();
        opts.forEach(o => { if (o.row) optRowSet.add(o.row); if (o.li) optRowSet.add(o.li); });

        // 找"题干范围"：题块内第一个选项行之前的文字；题块内没有题干则向前找兄弟
        let stemScope = block;
        let sentence = '';

        const firstRow = opts.length ? (opts[0].row || opts[0].li) : null;
        if (firstRow && block.contains(firstRow)) {
            const parts = [];
            const walker = block.ownerDocument.createTreeWalker(block, NodeFilter.SHOW_TEXT, null);
            let n = walker.nextNode();
            while (n) {
                if (firstRow.contains(n) || n.parentElement === firstRow) break;
                const t = (n.nodeValue || '').replace(/\s+/g, ' ').trim();
                if (t) parts.push(t);
                n = walker.nextNode();
            }
            sentence = parts.join(' ').replace(/\s+/g, ' ').trim();
        }

        // 题块里没有题干 → 向前找兄弟节点（真实页面：题干与选项列表是同级兄弟）
        if (!sentence || sentence.length < 10) {
            let sib = block.previousElementSibling;
            for (let k = 0; k < 4 && sib; k++, sib = sib.previousElementSibling) {
                if (optRowSet.has(sib)) continue;
                const t = (sib.textContent || '').replace(/\s+/g, ' ').trim();
                if (t.length >= 12 && extractChoiceOptions(sib).length < 2) {
                    sentence = t;
                    stemScope = sib;
                    break;
                }
            }
        }
        // 再兜底：用父容器里、选项列表之前的那段文字
        if ((!sentence || sentence.length < 10) && block.parentElement) {
            const p = block.parentElement;
            const parts = [];
            const walker = p.ownerDocument.createTreeWalker(p, NodeFilter.SHOW_TEXT, null);
            let n = walker.nextNode();
            while (n) {
                if (block.contains(n)) break;
                const t = (n.nodeValue || '').replace(/\s+/g, ' ').trim();
                if (t) parts.push(t);
                n = walker.nextNode();
            }
            const tail = parts.join(' ').replace(/\s+/g, ' ').trim();
            if (tail.length >= 12) sentence = tail;
        }
        sentence = sentence.replace(/^\s*\d+\s*[.、]\s*/, '').trim();

        // 划线部分：在"题干范围"内找，绝不能在选项区里找
        const searchScopes = [stemScope, block].filter((v, i, a) => v && a.indexOf(v) === i);
        let marked = '';
        let letterEl = null;
        for (const scope of searchScopes) {
            const marks = [...scope.querySelectorAll('u, ins, span, em, b, strong, a')]
                .filter(el => !el.closest('#weauto-panel, #weauto-ball'))
                .filter(el => ![...optRowSet].some(r => r && (r.contains(el))))
                .filter(el => isUnderlinedEl(el, scope.ownerDocument || document))
                .filter(el => !/^\s*[A-D]\s*$/.test((el.textContent || '').trim()));
            if (marks.length) {
                marks.sort((a, b) => a.getBoundingClientRect().top - b.getBoundingClientRect().top ||
                    a.getBoundingClientRect().left - b.getBoundingClientRect().left);
                letterEl = marks[0];
                marked = (letterEl.textContent || '').replace(/\s+/g, ' ').trim();
                break;
            }
        }
        if (!marked) {
            // 最后兜底：若句子里带了明显的下划线标记就用它，否则空着（不要用选项文字冒充）
            marked = '';
        }
        return { sentence, marked: marked.slice(0, 80), letterEl };
    }

    // 提取失败时把真实结构写进日志：不猜模板，直接把 DOM 摆出来
    function dumpUnderlineDebug() {
        const clip = (s, n) => String(s || '').replace(/\s+/g, ' ').slice(0, n || 400);
        log('---- 划线词辨析 诊断 ----');
        for (const doc of getDocuments()) {
            const body = doc.body;
            if (!body) continue;
            const t = clip(body.innerText || body.textContent, 200);
            log(`诊断 文档: ${clip(doc.location && doc.location.href, 80)} | 文本开头: ${t}`);
            // 各种可能的题块容器，看看真实页面用的是哪个
            ['.AnswerSheet_content', '.AnswerSheet_chooseBox', 'li[data-refids]', '.question',
                '[class*="question"]', '[class*="item"]', 'ul', 'ol'].forEach(sel => {
                try { log(`诊断 选择器 ${sel}: ${doc.querySelectorAll(sel).length} 个`); } catch (e) { /* ignore */ }
            });
            // 划线元素
            const marks = [...doc.querySelectorAll('u, ins, em, b, strong, span[style*="underline"]')]
                .filter(el => !el.closest('#weauto-panel, #weauto-ball'))
                .filter(el => (el.textContent || '').trim().length > 0)
                .slice(0, 5);
            log(`诊断 疑似划线元素: ${marks.length} 个`);
            marks.forEach(el => log(`诊断 划线 <${el.tagName}> "${clip(el.textContent, 40)}" | ${clip(el.outerHTML, 160)}`));
            // A/B/C/D 选项文本节点
            const letters = [...doc.querySelectorAll('span, div, li, p, label, b, strong')]
                .filter(el => !el.closest('#weauto-panel, #weauto-ball'))
                .filter(el => /^[A-D]\s*[.、:：)）]/.test((el.textContent || '').trim()))
                .filter(el => (el.textContent || '').trim().length < 120)
                .slice(0, 8);
            log(`诊断 疑似选项行: ${letters.length} 个`);
            letters.forEach(el => log(`诊断 选项 <${el.tagName} class="${clip(el.className, 50)}"> "${clip(el.textContent, 60)}" | ${clip(el.outerHTML, 200)}`));
            // 第一个题块的真实 HTML 全貌
            const firstBlock = doc.querySelector('li[data-refids], .AnswerSheet_chooseBox > li, .question, [class*="question"]');
            if (firstBlock) log(`诊断 首个题块: ${clip(firstBlock.outerHTML, 1400)}`);
        }
        log('---- 诊断结束 ----');
    }

    // 收集全部题目
    function findUnderlineItems() {
        const items = [];
        for (const block of findUnderlineQuestions()) {
            const opts = extractChoiceOptions(block);
            if (opts.length < 2) continue;
            const { sentence, marked, letterEl } = underlineTextOf(block, opts);
            if (!sentence || sentence.length < 10) continue;
            items.push({ index: items.length + 1, block, options: opts, sentence, marked, letterEl });
        }
        return items;
    }

    // LLM 提示词：严格按"读句子 → 排词性 → 辨微差 → 代入验证 → 只回 JSON"的顺序
    async function llmAnswerUnderline(items) {
        const systemPrompt =
            '你是英语词义辨析选择题答题助手。题目指令是 "Choose the answer that best explains each underlined part"，' +
            '即：选出最能解释句中划线部分（在本题语境下的含义）的选项。\n' +
            '请严格按下面顺序思考每一题（思考过程不要输出）：\n' +
            '1. 通读整句，弄清划线词修饰的对象、它在句中的语法角色与全句语境；\n' +
            '2. 先排除词性不符（名/动/形/副不一致）、语义领域无关的选项；\n' +
            '3. 在剩下的候选里区分近义项的细微差别（例如 numerous=数量多、various=种类多、common=常见、usual=惯常）；\n' +
            '4. 把候选选项逐个代入原句替换划线部分，验证句子是否通顺、是否保留原意；\n' +
            '5. 选出代入后最贴合语境的一个。\n' +
            '你必须只返回一个 JSON 对象，格式：{"answers":[{"index":1,"choice":"A"},{"index":2,"choice":"B"}]}。' +
            'index 为题目序号（从 1 开始，与输入一致），choice 只能是 A/B/C/D 之一，必须覆盖所有题目，不要返回任何解释文字。';
        const user = JSON.stringify({
            instruction: 'Choose the answer that best explains each underlined part.',
            items: items.map(q => ({
                index: q.index,
                sentence: q.sentence,
                underlined: q.marked,
                options: q.options.map(o => ({ letter: o.letter, text: o.text })),
            })),
        });
        const content = await llmRequest([
            { role: 'system', content: systemPrompt },
            { role: 'user', content: user },
        ]);
        const parsed = parseLLMJson(content);
        if (!parsed || !Array.isArray(parsed.answers)) throw new Error('模型返回格式不含 answers 数组');
        return parsed.answers;
    }

    // 选项"选中态"判定：class 标记 / aria 标记 / 蓝色系底色（rgb b>140 且 b-r>12）
    // 真实站点可能只给"选项行"加底色，也可能只给字母节点换样式，所以两者都要看
    function isChoiceSelected(opt) {
        const nodes = [opt.el, opt.li, opt.row, opt.el && opt.el.parentElement]
            .filter(Boolean)
            .filter((v, i, a) => a.indexOf(v) === i);
        for (const n of nodes) {
            const cls = String(n.className || '') + ' ' + String((n.parentElement && n.parentElement.className) || '');
            if (/(^|[\s_-])(active|selected|checked|current|choosed|chosen|sel|on)([\s_-]|$)/i.test(cls)) return true;
            if (n.getAttribute && (n.getAttribute('aria-selected') === 'true' || n.getAttribute('aria-checked') === 'true' || n.getAttribute('aria-pressed') === 'true')) return true;
        }
        for (const n of nodes) {
            try {
                const cs = getComputedStyle(n);
                const cands = [cs.backgroundColor];
                const bi = cs.backgroundImage || '';
                if (/gradient/i.test(bi)) cands.push(...(bi.match(/rgba?\([^)]*\)/g) || []));
                for (const c of cands) {
                    const m = String(c).match(/rgba?\((\d+),\s*(\d+),\s*(\d+)/);
                    if (!m) continue;
                    const r = +m[1], g = +m[2], b = +m[3];
                    // 蓝色系且足够"实"（排除白色/浅灰背景）
                    if (b > 140 && b - r > 12 && b >= g - 4) return true;
                }
            } catch (e) { /* ignore */ }
        }
        return false;
    }

    // 该题当前选中的是哪个选项（只在"整组里唯一选中"时采信）
    function selectedChoiceOf(item) {
        const hit = item.options.filter(o => isChoiceSelected(o));
        if (hit.length === 1) return hit[0];
        if (hit.length > 1) {
            // 多个命中说明 class 不可靠：取底色最蓝的那个
            return hit[0];
        }
        return null;
    }

    // 点击目标候选（按"用户真实操作"的顺序）。
    // 关键：不能用整行的中心点——真实页面里选项行常是很宽的块（整行 1000px+），
    // 中心点可能落在没有任何内容的空白处，浏览器命中不到站点绑定的处理器。
    // 所以优先点"选项文字本身"，其次点字母节点，最后才用它所在的容器。
    function choiceClickTargets(opt) {
        const out = [];
        const push = el => {
            if (!el || !el.isConnected || out.indexOf(el) >= 0) return;
            try {
                const r = el.getBoundingClientRect();
                if (r.width < 8 || r.height < 8) return;
            } catch (e) { return; }
            out.push(el);
        };
        // 1) 文字节点（最贴合用户点击位置）
        push(opt.textEl);
        // 2) 字母节点
        push(opt.el);
        // 3) 行容器 / 更外层（事件可能绑在这里）
        push(opt.row);
        push(opt.li);
        if (opt.row && opt.row.parentElement) push(opt.row.parentElement);
        if (!out.length) {
            if (opt.row && opt.row.isConnected) out.push(opt.row);
            else if (opt.el && opt.el.isConnected) out.push(opt.el);
        }
        return out;
    }

    // 真实点击一个选项（带完整事件序列与坐标），并回读校验是否进入选中态
    async function clickChoiceOnce(item, opt) {
        const targets = choiceClickTargets(opt);
        for (let ti = 0; ti < targets.length; ti++) {
            const t = targets[ti];
            if (isStopped()) return false;
            try { t.scrollIntoView({ block: 'center', inline: 'nearest' }); } catch (e) { /* ignore */ }
            await sleep(150);
            realClickAt(t);
            await sleep(500);
            if (choiceIsNowSelected(item, opt)) return true;
            // 被覆盖层挡住时按坐标命中最上层元素再点一次
            if (ti === 0) {
                const r = t.getBoundingClientRect();
                let top = null;
                try { top = t.ownerDocument.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2); } catch (e) { /* ignore */ }
                if (top && top !== t && !t.contains(top)) {
                    realClickAt(top);
                    await sleep(500);
                    if (choiceIsNowSelected(item, opt)) return true;
                }
            }
        }
        return false;
    }

    // 点击后判定：该题的选中项是不是我们要的这个字母。
    // 注意不能用对象引用比较——findUnderlineItems 每次都生成新对象，引用永远不相等。
    function choiceIsNowSelected(item, opt) {
        // 优先看"整题的选中项"（这是站点真正登记的状态）
        const fresh = findUnderlineItems().find(x => x.index === item.index);
        if (fresh) {
            const cur = selectedChoiceOf(fresh);
            if (cur && cur.letter === opt.letter) return true;
            // 选中项存在但不是它 → 说明这次点击没生效或点错了
            if (cur && cur.letter !== opt.letter) {
                // 再看一眼目标选项自己的节点样式（有些模板只给单项加样式而不互斥）
                const sameLetter = fresh.options.find(o => o.letter === opt.letter);
                if (sameLetter && isChoiceSelected(sameLetter)) return true;
                return false;
            }
        }
        // 整题都读不到选中项时，退回看目标选项自身的节点
        return isChoiceSelected(opt);
    }

    // 带坐标的真实点击（pointerdown → mousedown → pointerup → mouseup → click）
    function realClickAt(el) {
        if (!el) return;
        const view = el.ownerDocument.defaultView || window;
        const r = el.getBoundingClientRect();
        const cx = r.left + r.width / 2;
        const cy = r.top + r.height / 2;
        const base = {
            bubbles: true, cancelable: true, composed: true, view,
            clientX: cx, clientY: cy, screenX: cx, screenY: cy,
            button: 0, detail: 1,
        };
        const fire = (type, buttons, pointer) => {
            try {
                if (pointer && typeof view.PointerEvent === 'function') {
                    el.dispatchEvent(new view.PointerEvent(type, Object.assign({}, base, {
                        buttons, pointerId: 1, pointerType: 'mouse', isPrimary: true,
                    })));
                } else {
                    el.dispatchEvent(new view.MouseEvent(type, Object.assign({}, base, { buttons })));
                }
            } catch (e) { /* ignore */ }
        };
        fire('pointerdown', 1, true);
        fire('mousedown', 1, false);
        if (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA') {
            try { el.focus({ preventScroll: true }); } catch (e) { /* ignore */ }
        }
        fire('pointerup', 0, true);
        fire('mouseup', 0, false);
        fire('click', 0, false);
    }

    // 给一道题选中指定字母的选项；返回 true 表示已确认进入选中态
    async function selectChoiceForItem(item, wantLetter) {
        const tag = `第 ${item.index} 题`;
        if (!wantLetter) { log(`${tag}：没有可用答案，跳过`); return false; }
        const liveOpts = () => {
            const fresh = findUnderlineItems().find(x => x.index === item.index);
            return (fresh && fresh.options.length) ? fresh : item;
        };
        // 先看是否已经选中了这个选项（不要重复点，避免点掉）
        // 用实时提取的对象判断，不能用传进来（可能已过期）的 item
        const freshNow = findUnderlineItems().find(x => x.index === item.index);
        let cur = selectedChoiceOf(freshNow || item);
        if (cur && cur.letter === wantLetter) {
            log(`${tag}：已处于选中态（${wantLetter}），无需重复点击`);
            return true;
        }
        for (let attempt = 0; attempt < 4; attempt++) {
            if (isStopped()) return false;
            const live = liveOpts();
            const opt = live.options.find(o => o.letter === wantLetter);
            if (!opt) { log(`${tag}：找不到 ${wantLetter} 选项`); return false; }
            const ok = await clickChoiceOnce(live, opt);
            if (ok) return true;
            log(`${tag}：第 ${attempt + 1} 次点击未选中，重试`);
        }
        return false;
    }

    async function fillUnderlineChoice() {
        if (!looksLikeUnderlineChoice()) return false;
        // 题目可能异步渲染，未提取到时再等几轮
        let items = findUnderlineItems();
        for (let round = 0; round < 4 && !items.length; round++) {
            log(`等待划线词辨析题加载…(${round + 1}/4)`);
            await sleep(1200);
            items = findUnderlineItems();
        }
        if (!items.length) {
            log('!! 识别到划线词辨析题，但未提取到题目结构，输出诊断');
            dumpUnderlineDebug();
            return true;   // 确认是本题型，避免落到通用兜底乱点
        }
        log(`检测到划线词词义辨析题，共 ${items.length} 题`);
        items.slice(0, 3).forEach(q => {
            log(`  第 ${q.index} 题：划线 "${q.marked}" | 选项 ${q.options.map(o => o.letter + '.' + o.text).join(' / ')}`);
        });

        // 取 LLM 答案
        let answers = [];
        const conf = loadLLMConfig();
        if (conf && conf.apiKey) {
            try {
                answers = await llmAnswerUnderline(items);
                log(`大模型已返回 ${answers.length} 个答案`);
            } catch (e) {
                log('大模型作答失败:', e.message, '—— 尝试使用页面内置答案');
            }
        } else {
            log('未配置大模型，尝试使用页面内置答案');
        }

        // 组装计划：LLM → 页面 data-solution → 空
        const plan = new Map();
        for (const it of items) {
            const a = (answers || []).find(x => Number(x.index) === it.index);
            let letter = a && String(a.choice || '').trim().toUpperCase().charAt(0);
            if (!letter || !it.options.some(o => o.letter === letter)) {
                // 兜底：题目上若带 data-solution（形如 "A" 或 "A. xxx"）就用它
                const sol = ((it.block.getAttribute && it.block.getAttribute('data-solution')) || '').trim().toUpperCase().charAt(0);
                letter = (sol && it.options.some(o => o.letter === sol)) ? sol : '';
            }
            if (letter) plan.set(it.index, letter);
        }
        log('作答计划: ' + items.map(i => `${i.index}→${plan.get(i.index) || '?'}`).join(' '));
        // 同步给提交被拒后的补选逻辑
        underlinePlan.clear();
        plan.forEach((v, k) => underlinePlan.set(k, v));
        if (!plan.size) {
            log('!! 没有拿到任何答案（检查 API Key），本页跳过');
            return true;
        }

        // 逐题真实点击
        let done = 0;
        for (const item of items) {
            if (isStopped()) { log('检测到停止指令，中止划线词辨析'); return true; }
            const want = plan.get(item.index);
            if (!want) { log(`第 ${item.index} 题：无答案，跳过`); continue; }
            const optText = (item.options.find(o => o.letter === want) || {}).text || '';
            const ok = await selectChoiceForItem(item, want);
            if (ok) {
                done++;
                log(`第 ${item.index} 题：划线词 "${item.marked}" → 选择 ${want} (${optText})，已选中`);
            } else {
                log(`第 ${item.index} 题：选择 ${want} (${optText}) 未成功选中`);
            }
            await sleep(150);
        }

        // 终检：只读不点，统计仍未选中的题；有则补选一轮（绝不动已选中的题）
        const items2 = findUnderlineItems();
        const pending = items2.filter(it => {
            const want = plan.get(it.index);
            if (!want) return false;
            const cur = selectedChoiceOf(it);
            return !cur || cur.letter !== want;
        });
        if (pending.length) {
            log(`终检发现 ${pending.length} 题未选中，补选一轮: ${pending.map(p => p.index).join(',')}`);
            for (const it of pending) {
                if (isStopped()) { log('检测到停止指令，中止补选'); return true; }
                const want = plan.get(it.index);
                const cur = selectedChoiceOf(it);
                if (cur && cur.letter === want) continue;   // 已正确，不动它
                await selectChoiceForItem(it, want);
                await sleep(150);
            }
        }

        // 最终统计
        const finalItems = findUnderlineItems();
        let remain = 0;
        const summary = [];
        for (const it of finalItems) {
            const cur = selectedChoiceOf(it);
            if (!cur) { remain++; summary.push(`${it.index}:空`); }
            else summary.push(`${it.index}:${cur.letter}`);
        }
        log(`划线词辨析完成：成功 ${finalItems.length - remain}/${finalItems.length}，剩余未选 ${remain}`);
        log('最终答案显示: ' + summary.join(' '));
        return true;
    }

    /* ===================== 通用题型提取（radio/checkbox/文本框/下拉，备用） ===================== */
    function extractQuestions() {
        const questions = [];
        const seenContainers = new Set();

        getDocuments().forEach(doc => {
            const groups = {};
            doc.querySelectorAll('input[type=radio], input[type=checkbox]').forEach(inp => {
                if (inp.closest('#weauto-panel, #weauto-overlay')) return;
                const key = (inp.type === 'radio' ? 'R:' : 'C:') + (inp.name || inp.closest('li,div,tr')?.id || Math.random());
                (groups[key] = groups[key] || []).push(inp);
            });

            Object.values(groups).forEach(inputs => {
                let container = inputs[0].closest('li, tr, .question, [class*="question"], [class*="item"]') || inputs[0].parentElement;
                while (container && !inputs.every(i => container.contains(i))) container = container.parentElement;
                if (!container || seenContainers.has(container)) return;
                seenContainers.add(container);

                const options = inputs.map(inp => {
                    const label = inp.closest('label') || doc.querySelector(`label[for="${inp.id}"]`) || inp.parentElement;
                    return textOf(label).replace(/\s+/g, ' ').slice(0, 200);
                });
                let q = textOf(container).replace(/\s+/g, ' ');
                options.forEach(o => { q = q.replace(o, ' '); });
                q = q.replace(/\s+/g, ' ').trim().slice(0, 800);

                questions.push({
                    index: questions.length + 1,
                    type: inputs[0].type === 'radio' ? 'choice' : 'check',
                    question: q, options, _inputs: inputs,
                });
            });

            doc.querySelectorAll('input[type=text], textarea').forEach(inp => {
                if (inp.closest('#weauto-panel, #weauto-overlay')) return;
                if (inp.disabled || inp.readOnly || inp.offsetParent === null) return;
                const container = inp.closest('li, tr, .question, [class*="question"], p, div') || inp.parentElement;
                let q = textOf(container).replace(/\s+/g, ' ').trim().slice(0, 800);
                if (!q || q.length < 4) q = '（页面填空题，上下文不足）';
                questions.push({ index: questions.length + 1, type: 'fill', question: q, options: [], _inputs: [inp] });
            });

            doc.querySelectorAll('select').forEach(sel => {
                if (sel.closest('#weauto-panel, #weauto-overlay')) return;
                if (sel.offsetParent === null) return;
                const container = sel.closest('li, tr, .question, [class*="question"], p, div') || sel.parentElement;
                const options = [...sel.options].map(o => o.text.trim()).filter(Boolean);
                questions.push({
                    index: questions.length + 1, type: 'select',
                    question: textOf(container).replace(/\s+/g, ' ').trim().slice(0, 800),
                    options, _inputs: [sel],
                });
            });
        });

        return questions;
    }

    async function llmAnswerGeneric(questions) {
        const quiz = questions.map(q => ({ index: q.index, type: q.type, question: q.question, options: q.options }));
        const systemPrompt =
            '你是英语课程练习答题助手。用户会给你一组题目(JSON数组)，type含义：' +
            'choice=单选, check=多选, fill=填空, select=下拉选择。' +
            '你必须只返回一个JSON对象，格式：{"answers":[{"index":题目序号,"answer":答案}]}。' +
            'answer规则：choice/select 填正确选项的序号(从0开始的整数)；check 填序号数组(如[0,2])；fill 填要填入的英文单词或短语字符串。' +
            '不要返回任何解释文字。';
        const content = await llmRequest([
            { role: 'system', content: systemPrompt },
            { role: 'user', content: JSON.stringify(quiz) },
        ]);
        const parsed = parseLLMJson(content);
        if (!parsed || !Array.isArray(parsed.answers)) throw new Error('模型返回格式不含 answers 数组');
        return parsed.answers;
    }

    function applyAnswers(questions, answers) {
        let applied = 0;
        answers.forEach(ans => {
            const q = questions.find(x => x.index === ans.index);
            if (!q) return;
            try {
                if (q.type === 'choice') {
                    const i = Number(ans.answer);
                    if (q._inputs[i]) { q._inputs[i].click(); applied++; }
                } else if (q.type === 'check') {
                    const arr = Array.isArray(ans.answer) ? ans.answer : [Number(ans.answer)];
                    arr.forEach(i => { if (q._inputs[i] && !q._inputs[i].checked) q._inputs[i].click(); });
                    applied++;
                } else if (q.type === 'fill') {
                    const inp = q._inputs[0];
                    inp.value = String(ans.answer);
                    inp.dispatchEvent(new Event('input', { bubbles: true }));
                    inp.dispatchEvent(new Event('change', { bubbles: true }));
                    applied++;
                } else if (q.type === 'select') {
                    const sel = q._inputs[0];
                    const i = Number(ans.answer);
                    if (sel.options[i] !== undefined) {
                        sel.selectedIndex = i;
                        sel.dispatchEvent(new Event('change', { bubbles: true }));
                        applied++;
                    }
                }
            } catch (e) {
                log(`第 ${ans.index} 题应用答案失败:`, e.message);
            }
        });
        log(`大模型答案已应用 ${applied}/${questions.length} 题`);
    }

    function fallbackAnswer() {
        getDocuments().forEach(doc => {
            const radioGroups = {};
            doc.querySelectorAll('input[type=radio]').forEach(r => {
                if (r.closest('#weauto-panel, #weauto-overlay')) return;
                if (!radioGroups[r.name]) { radioGroups[r.name] = true; r.click(); }
            });
            doc.querySelectorAll('input[type=checkbox]').forEach((c, i) => { if (i === 0 || !c.checked) c.click(); });
            doc.querySelectorAll('input[type=text], textarea').forEach(t => {
                if (t.closest('#weauto-panel, #weauto-overlay')) return;
                if (!t.value) { t.value = 'the'; t.dispatchEvent(new Event('input', { bubbles: true })); t.dispatchEvent(new Event('change', { bubbles: true })); }
            });
            doc.querySelectorAll('select').forEach(s => {
                if (s.closest('#weauto-panel, #weauto-overlay')) return;
                if (s.selectedIndex <= 0 && s.options.length > 1) { s.selectedIndex = 1; s.dispatchEvent(new Event('change', { bubbles: true })); }
            });
        });
    }

    /* ===================== 练习行检索 ===================== */
    // 用标题文字的颜色判断：灰色标题 = 未开放
    function isLockedRow(row) {
        const cls = String(row.className || '').toLowerCase();
        if (CFG.lockedClassKeywords.some(k => cls.includes(k))) return true;
        if (textOf(row).includes('未开放')) return true;

        const leaves = [...row.querySelectorAll('*')].filter(el => !el.children.length && textOf(el).trim().length >= 3);
        if (!leaves.length) return isGrayColor(row);
        leaves.sort((a, b) => textOf(b).length - textOf(a).length);
        return isGrayColor(leaves[0]);
    }

    // 判断单个元素（含自身）是否带绿色标记（完成的对勾）
    // 注意：只看颜色/图片，不看 class 关键词——class 里 not-finished、check-circle 之类都会误判
    function hasGreenMark(row) {
        const els = [row, ...row.querySelectorAll('*')];
        for (const el of els) {
            if (el.tagName === 'IMG') {
                const src = (el.getAttribute('src') || '').toLowerCase();
                if (/ok|right|correct|success|finish|complete|pass|done|check|dui|gou/.test(src)) return true;
            }
            const st = getComputedStyle(el);
            const colors = [st.color, st.backgroundColor, st.borderTopColor, st.fill, st.stroke].join(' ');
            const rgbList = colors.match(/rgba?\((\d+),\s*(\d+),\s*(\d+)/g) || [];
            for (const c of rgbList) {
                const [r, g, b] = c.match(/\d+/g).map(Number);
                // 明显偏绿（对勾图标通常 #4caf50 / #52c41a 一类）
                if (g > 110 && g - r > 35 && g - b > 35) return true;
            }
        }
        return false;
    }

    // 已完成判定：绿色对勾 / 分数（如 "100分"）/ 明确完成文字
    function isCompletedRow(row) {
        const t = textOf(row);
        if (/已完成|已提交/.test(t)) return true;
        if (/(^|\s)\d{1,3}(\.\d+)?\s*分/.test(t)) return true;   // 有分数 = 已提交
        return hasGreenMark(row);
    }

    // 只保留最内层（同一行有多层容器时，取最具体的那个）
    function innermost(els) {
        return els.filter(el => !els.some(o => o !== el && el.contains(o)));
    }

    // 把标题元素向上扩展到"整行"容器（包含右侧的分数/用时）
    function toRowBox(el) {
        let node = el;
        for (let i = 0; i < 3 && node.parentElement; i++) {
            const p = node.parentElement;
            const pr = p.getBoundingClientRect(), cr = node.getBoundingClientRect();
            if (pr.width > cr.width + 40 && pr.height < cr.height * 2.6) node = p;
            else break;
        }
        return node;
    }

    // 抓出所有练习行：三种策略，从精确到宽松
    function findPracticeRows(doc) {
        const SKIP = (el) => el.closest('#weauto-panel, #weauto-ball');
        const tc = (el) => el.textContent || '';
        const visible = (el) => { const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0; };
        // 表头行（课程介绍 / Unit N / 含"已完成："统计）不是练习行
        const isHeader = (t) => /课程介绍|^unit\s*\d|已完成\s*[:：]/i.test(t.replace(/\s+/g, ' ').trim());

        // 策略1：含"用时 hh:mm"（兼容全角冒号）
        const timeRe = /用时\s*\d{1,3}\s*[:：]\s*\d{2}/;
        let rows = innermost([...doc.querySelectorAll('li, div, tr, dd, dl, a, p, section')].filter(el => {
            if (SKIP(el)) return false;
            const t = tc(el);
            if (!timeRe.test(t)) return false;
            if ((t.match(/用时/g) || []).length !== 1) return false;
            const stripped = t.replace(timeRe, '').replace(/\d{1,3}(\.\d+)?\s*分/g, '').trim();
            if (stripped.length < 4) return false;
            if (isHeader(stripped)) return false;
            return visible(el);
        }));
        if (rows.length) return rows;

        // 策略2：按标题特征（课程目录的练习标题都带 ">" 分隔符，或为 Overview）
        const titleEls = innermost([...doc.querySelectorAll('li, div, tr, dd, dl, a, p, section, span')].filter(el => {
            if (SKIP(el)) return false;
            const t = tc(el).replace(/\s+/g, ' ').trim();
            if (t.length < 3 || t.length > 120) return false;
            if (isHeader(t)) return false;
            if (!/[>›»]/.test(t) && !/^overview$/i.test(t)) return false;
            const r = el.getBoundingClientRect();
            return r.width > 60 && r.height > 8;
        }));
        if (titleEls.length) {
            const boxes = titleEls.map(toRowBox);
            return innermost(boxes);
        }

        // 策略3：几何分行（兜底，不依赖任何文字）
        const groups = new Map();
        [...doc.querySelectorAll('li, div, tr, dd, dl, a, p, section, span')].forEach(el => {
            if (SKIP(el)) return;
            const r = el.getBoundingClientRect();
            if (r.height < 14 || r.height > 52) return;
            if (r.width < 200) return;
            const t = tc(el).trim();
            if (t.length < 3 || t.length > 200) return;
            if (isHeader(t)) return;
            const key = Math.round(r.top / 4) * 4;
            const prev = groups.get(key);
            if (!prev || r.width > prev.r.width) groups.set(key, { el, r });
        });
        return [...groups.values()].map(g => g.el);
    }

    // 判断某个练习行属于第几个单元（按文档顺序，不用几何位置）
    function unitIndexForRow(row, headers) {
        let idx = -1;
        headers.forEach((h, i) => {
            if (h.contains(row) || row.contains(h)) return;
            const pos = h.compareDocumentPosition(row);
            if (pos & Node.DOCUMENT_POSITION_FOLLOWING) idx = i; // row 在 h 之后
        });
        return idx;
    }

    // 练习行的稳定标识：去掉"用时 xx:xx""100分"等会变化的文字
    const taskKey = (t) => String(t || '').replace(/\s+/g, ' ').trim().slice(0, 80);
    const normKey = (t) => taskKey(t).toLowerCase().replace(/[^a-z0-9\u4e00-\u9fa5]/g, '');
    const rowKey = (row) => taskKey(
        textOf(row)
            .replace(/用时\s*\d{1,3}:\d{2}(?::\d{2})?/g, '')
            .replace(/\d{1,3}(\.\d+)?\s*分/g, '')
            .replace(/已完成[^\s]*/g, '')
    );

    // 取某个单元块内的练习行（按文档顺序归属）
    function rowsOfUnit(unitIndex) {
        const headers = getUnitHeaders();
        if (!headers[unitIndex]) return [];
        const doc = headers[0].ownerDocument;
        return findPracticeRows(doc).filter(r => unitIndexForRow(r, headers) === unitIndex);
    }

    // 该单元未完成的开放练习（排除未开放 / 已完成 / 本地记录已完成）
    function pendingRowsOfUnit(unitIndex) {
        const rows = rowsOfUnit(unitIndex);
        const open = rows.filter(r => !isLockedRow(r));
        const pending = [];
        let doneCount = 0;
        open.forEach(r => {
            if (isCompletedRow(r) || isTaskDone(rowKey(r))) doneCount++;
            else pending.push(r);
        });
        log(`Unit ${unitIndex + 1}: 练习行 ${rows.length}，开放 ${open.length}，已完成 ${doneCount}，待完成 ${pending.length}`);
        return pending;
    }

    function isTaskDone(key) {
        const st = loadState();
        const done = st.done || {};
        const nk = normKey(key);
        return Object.keys(done).some(k => k === key || normKey(k) === nk);
    }

    function markTaskDone(key) {
        if (!key) return;
        const st = loadState();
        st.done = st.done || {};
        st.done[taskKey(key)] = Date.now();
        saveState(st);
    }

    function clickRow(row) {
        const target = row.querySelector('a[href], a, [onclick]') || row;
        log('进入练习:', textOf(row).slice(0, 60));
        realClick(target);
    }

    function getUnitHeaders() {
        // 同一单元可能出现多层容器，取文字最短（最具体）的那个，并按单元号排序
        const byNum = new Map();
        [...document.querySelectorAll(CFG.unitTitleSelector)].forEach(el => {
            const t = textOf(el);
            const m = t.match(/Unit\s*(\d+)/i);
            if (!m) return;
            const r = el.getBoundingClientRect();
            if (r.width === 0 && r.height === 0) return;
            const num = Number(m[1]);
            const prev = byNum.get(num);
            if (!prev || t.length < prev.len) byNum.set(num, { el, len: t.length });
        });
        return [...byNum.keys()].sort((a, b) => a - b).map(n => byNum.get(n).el);
    }

    async function expandUnit(unitIndex) {
        const u = getUnitHeaders()[unitIndex];
        if (!u) return false;
        if (rowsOfUnit(unitIndex).length) return true;   // 已经有可见练习行，说明已展开

        log('尝试展开单元:', textOf(u).slice(0, 40));
        // 关键：先把单元标题滚进视口。后续单元常被上一单元展开的行顶到屏幕外，
        // 不滚动则展开开关点击无效（与"人工下滑后才能展开"的现象一致）
        u.scrollIntoView({ block: 'center' });
        await sleep(500);

        const rowBox = toRowBox(u);
        const findPlus = () => [...rowBox.querySelectorAll('*')].find(el => ['+', '＋'].includes(textOf(el).trim()));
        const boxRect = rowBox.getBoundingClientRect();
        const rightIcon = document.elementFromPoint(boxRect.right - 14, boxRect.top + boxRect.height / 2);

        // 逐个尝试展开开关；每次点击后轮询等待行渲染，一旦出现练习行立即返回，
        // 避免继续点击把已展开的单元又折叠回去
        const candidates = [findPlus(), rightIcon, rowBox].filter(Boolean);
        for (const c of candidates) {
            if (c.scrollIntoView) c.scrollIntoView({ block: 'center' });
            await sleep(200);
            realClick(c);
            for (let i = 0; i < 6; i++) {
                await sleep(500);
                if (rowsOfUnit(unitIndex).length) return true;
            }
        }
        // 最后尝试点击单元标题本身
        u.scrollIntoView({ block: 'center' });
        await sleep(200);
        realClick(u);
        for (let i = 0; i < 6; i++) {
            await sleep(500);
            if (rowsOfUnit(unitIndex).length) return true;
        }
        log('!! 该单元展开后仍未识别到练习行');
        return false;
    }

    /* =====================【修复：单元遍历完整性】===================== */
    // 问题（v2.9.33）：目录流程跑完 Unit 7 就报"所有单元处理完毕"，并未进入 Unit 8。
    // 根因：
    //   ① getUnitHeaders() 依赖 CFG.unitTitleSelector('[class*="unit"], .unitTitle, h3, h4')，
    //      站点改版后末尾单元取不到 → units.length 变短，循环自然在 Unit 7 结束；
    //   ② 单元是懒加载的：后面的单元没滚到视口就不会渲染出标题；
    //   ③ 展开 Unit 7 后新插入的练习行把 Unit 8 标题挤出视口/重排 DOM，
    //      而 getUnitHeaders() 是"按单元号排序后取数组下标"，unitIndex + 1 会指偏或越界。
    // 以下只做加法、不改动原有函数：不再假设"下一个单元一定在列表里"，
    // 改为按「单元号 + 文档顺序」定位，配合滚动触发懒加载，保证最后一个单元也能被执行。

    const TRAVERSE_KEY = 'weauto_units_traverse_v1';  // 单元遍历进度（独立键，不影响原 STATE_KEY）
    const UNIT_MAX_INDEX = 60;                        // 安全上限，防止误判导致无限循环
    let UNIT_HEADER_CACHE = [];                       // 已渲染过、但当前可能滚出视口的单元标题

    function loadTraverse() {
        try { return JSON.parse(localStorage.getItem(TRAVERSE_KEY)) || { visited: {} }; }
        catch (e) { return { visited: {} }; }
    }
    function saveTraverse(tv) { localStorage.setItem(TRAVERSE_KEY, JSON.stringify(tv)); }
    function markUnitVisited(unitNum) {
        const tv = loadTraverse();
        tv.visited = tv.visited || {};
        tv.visited[String(unitNum)] = Date.now();
        saveTraverse(tv);
    }

    // 从文字里解析单元号："Unit 8 Understanding Other Cultures" → 8
    function unitNumOfText(t) {
        const m = String(t || '').replace(/\s+/g, ' ')
            .match(/(?:^|[^A-Za-z0-9])Unit\s*([0-9]{1,2})(?![0-9])/i);
        return m ? Number(m[1]) : 0;
    }

    // 兜底：选择器失效时，直接按文字找"最具体的"单元标题元素
    function findUnitTitleByText(doc) {
        const out = [];
        [...(doc || document).querySelectorAll('li, div, td, dd, dt, h1, h2, h3, h4, h5, p, span, a, strong, b')].forEach(el => {
            if (el.closest('#weauto-panel, #weauto-ball, #weauto-overlay')) return;
            const t = textOf(el).replace(/\s+/g, ' ');
            if (!t || t.length > 120) return;
            const num = unitNumOfText(t);
            if (!num) return;
            // 只要最内层：内部不应再含一个同号的单元标题（否则会抓到整个列表容器）
            const nested = [...el.querySelectorAll('*')].some(c => unitNumOfText(textOf(c)) === num);
            if (nested) return;
            out.push(el);
        });
        return out;
    }

    // 汇总当前页面所有单元标题（选择器 + 文字兜底 + 缓存），按单元号升序返回 [{num, el}]
    function getUnitHeadersAll(doc) {
        const byNum = new Map();
        const put = (el) => {
            if (!el) return;
            const num = unitNumOfText(textOf(el));
            if (!num || num > UNIT_MAX_INDEX) return;
            const prev = byNum.get(num);
            if (!prev || textOf(el).length < textOf(prev).length) byNum.set(num, el);  // 取最具体的
        };
        try { [...(doc || document).querySelectorAll(CFG.unitTitleSelector)].forEach(put); } catch (e) { /* ignore */ }
        findUnitTitleByText(doc).forEach(put);
        UNIT_HEADER_CACHE.forEach(put);
        const nums = [...byNum.keys()].sort((a, b) => a - b);
        UNIT_HEADER_CACHE = nums.map(n => byNum.get(n)).filter(el => el && el.isConnected);
        return nums.map(n => ({ num: n, el: byNum.get(n) }));
    }

    // 某元素归属哪个单元（文档顺序：在其标题之后、下一个单元标题之前）
    function unitNumForElement(el, list) {
        let cur = 0;
        for (const h of list) {
            if (h.el === el || h.el.contains(el)) return h.num;
            if (h.el.compareDocumentPosition(el) & Node.DOCUMENT_POSITION_FOLLOWING) cur = h.num;
        }
        return cur;
    }

    function rowsOfUnitNum(unitNum, list) {
        list = list || getUnitHeadersAll();
        const doc = (list[0] && list[0].el.ownerDocument) || document;
        return findPracticeRows(doc).filter(r => unitNumForElement(r, list) === unitNum);
    }

    // 该单元"开放且未完成"的练习行（判定口径与 pendingRowsOfUnit 完全一致）
    function pendingRowsOfUnitNum(unitNum, list) {
        list = list || getUnitHeadersAll();
        const rows = rowsOfUnitNum(unitNum, list);
        const open = rows.filter(r => !isLockedRow(r));
        const pending = [];
        let doneCount = 0;
        open.forEach(r => {
            if (isCompletedRow(r) || isTaskDone(rowKey(r))) doneCount++;
            else pending.push(r);
        });
        log(`Unit ${unitNum}: 练习行 ${rows.length}，开放 ${open.length}，已完成 ${doneCount}，待完成 ${pending.length}`);
        return pending;
    }

    // 滚一遍整页，触发站点懒加载（后面的单元这时才渲染出来）
    async function lazyScrollThroughPage() {
        try {
            const before = getUnitHeadersAll().length;
            const step = Math.max(240, Math.round(window.innerHeight * 0.85));
            const maxY = () => Math.max(document.body.scrollHeight, document.documentElement.scrollHeight);
            let y = 0, n = 0;
            while (n++ < 60 && y < maxY() - 4) {
                y += step;
                window.scrollTo(0, y);
                await sleep(220);
            }
            window.scrollTo(0, maxY());
            await sleep(600);
            const after = getUnitHeadersAll().length;
            if (after > before) log(`滚动加载后单元数 ${before} → ${after}`);
            window.scrollTo(0, 0);
            await sleep(400);
        } catch (e) { /* 滚动失败不影响主流程 */ }
    }

    // 【修复】目录流程：按单元号顺序把所有开放未完成练习做完才结束
    async function runCoursePageAllUnits() {
        await sleep(CFG.pageSettleDelay);
        const state = loadState();
        if (!state.running) return;

        // ① 先滚动触发懒加载，避免末尾单元（Unit 8）根本没渲染
        await lazyScrollThroughPage();

        let list = getUnitHeadersAll();
        if (!list.length) {
            log('未检测到单元列表，任务结束');
            state.running = false;
            saveState(state);
            return;
        }
        log(`检测到单元 ${list.length} 个（Unit ${list[0].num} ~ Unit ${list[list.length - 1].num}），练习行共 ${findPracticeRows(list[0].el.ownerDocument).length} 个`);

        // ② 起始单元：state.unitIndex 是旧流程的数组下标，这里换算成单元号并持久化
        const startIdx = Math.min(Math.max(0, state.unitIndex | 0), list.length - 1);
        if (!(state.unitNo >= 1)) state.unitNo = list[startIdx].num;
        saveState(state);

        let guard = 0;
        while (guard++ < UNIT_MAX_INDEX) {
            if (isStopped()) { log('检测到停止指令，中止目录流程'); return; }

            // 每轮重新扫描：展开单元会改变 DOM，必须按单元号重新定位标题，
            // 绝不用"上一步的数组下标 +1"（这正是跳过/漏掉 Unit 8 的根因）
            list = getUnitHeadersAll();
            let head = (list.find(h => h.num === state.unitNo) || {}).el;

            if (!head) {
                await lazyScrollThroughPage();          // 可能还没渲染出来，再滚一遍确认
                list = getUnitHeadersAll();
                head = (list.find(h => h.num === state.unitNo) || {}).el;
            }
            if (!head) {
                const lastNum = list.length ? list[list.length - 1].num : 0;
                if (state.unitNo > lastNum) { log(`页面已无 Unit ${state.unitNo}，全部单元处理完毕`); break; }
                log(`未找到 Unit ${state.unitNo}，跳到下一个单元号`);
                state.unitNo++;
                saveState(state);
                continue;
            }

            head.scrollIntoView({ block: 'center' });   // 先滚进视口，否则展开点击无效
            await sleep(600);

            // 复用原 expandUnit，但传入按单元号重新定位后的下标
            const idxByNum = list.findIndex(h => h.num === state.unitNo);
            if (idxByNum >= 0) await expandUnit(idxByNum);
            await sleep(600);

            const pending = pendingRowsOfUnitNum(state.unitNo);
            if (!pending.length) {
                log(`Unit ${state.unitNo} 没有待完成的开放练习，进入下一单元`);
                markUnitVisited(state.unitNo);
                state.unitNo++;
                state.unitIndex = Math.max(0, idxByNum);
                saveState(state);
                continue;
            }

            const row = pending[0];
            const key = rowKey(row);
            state.pendingList = pending.map(rowKey);
            state.currentTask = key;
            state.phase = 'exercise';
            state.unitIndex = Math.max(0, idxByNum);    // 兼容旧字段，返回目录后仍对得上
            saveState(state);
            log(`Unit ${state.unitNo} 待完成 ${pending.length} 个，先做第 1 个`);
            if (isStopped()) { log('检测到停止指令，不进入练习'); return; }
            clickRow(row);
            return;
        }

        log('所有单元（含最后一个单元）的开放未完成练习已全部处理完毕，任务结束！');
        state.running = false;
        state.phase = 'course';
        saveState(state);
    }

    /* ===================== 当前页面所属练习的识别 ===================== */
    function getPageHeadingText() {
        for (const doc of getDocuments()) {
            const cands = [...doc.querySelectorAll('div, span, p, h1, h2, h3, h4, a, li')].filter(el => {
                if (el.closest('#weauto-panel, #weauto-ball')) return false;
                const t = textOf(el);
                if (!t || t.length > 120) return false;
                if (!/[›»>]/.test(t)) return false;
                return /Task|Reading|Cultural|Reflecting|Overview|Warm-up|Viewing|Text|Additional|Language/i.test(t);
            });
            if (cands.length) {
                cands.sort((a, b) => textOf(a).length - textOf(b).length);
                return taskKey(textOf(cands[0]));
            }
        }
        return taskKey(document.title);
    }

    function keysSimilar(a, b) {
        const na = normKey(a), nb = normKey(b);
        if (!na || !nb) return false;
        if (na === nb || na.includes(nb) || nb.includes(na)) return true;
        const ma = na.match(/task(\d+)$/), mb = nb.match(/task(\d+)$/);
        return !!(ma && mb && ma[1] === mb[1] && (na.slice(0, 8) === nb.slice(0, 8)));
    }

    // 解析"当前这一节"对应的任务标识：优先用 state.currentTask，其次匹配待办列表
    function resolveCurrentTaskKey() {
        const st = loadState();
        const heading = getPageHeadingText();
        if (st.currentTask && keysSimilar(st.currentTask, heading)) return st.currentTask;
        const list = st.pendingList || [];
        const hit = list.find(k => keysSimilar(k, heading));
        if (hit) return hit;
        const nk = normKey(heading);
        if (nk.length >= 8 && !nk.startsWith('welearn')) return heading;
        return '';
    }

    /* ===================== 「下节」按钮 ===================== */
    function findNextSectionButton() {
        const TEXTS = ['下节', '下一节', '下一课'];
        let best = null;
        for (const doc of getDocuments()) {
            const els = [...doc.querySelectorAll('a, button, div, span, li, td, p')];
            for (const el of els) {
                if (el.closest('#weauto-panel, #weauto-ball')) continue;
                const t = textOf(el).replace(/\s+/g, '').toLowerCase();
                if (!t || t.length > 8) continue;
                if (!TEXTS.some(x => t === x)) continue;
                const r = el.getBoundingClientRect();
                if (r.width === 0 && r.height === 0) continue;
                if (!best || textOf(el).length < textOf(best).length) best = el;
            }
            if (best) break;
        }
        return best;
    }

    // 控件是否处于禁用/未开放状态
    function isControlDisabled(el) {
        if (!el) return true;
        let node = el;
        for (let i = 0; i < 3 && node; i++, node = node.parentElement) {
            if (node.disabled) return true;
            if (node.getAttribute && node.getAttribute('aria-disabled') === 'true') return true;
            const cls = String(node.className || '').toLowerCase();
            if (/disabled|disable|forbid|lock|notopen|unopen/.test(cls)) return true;
            const st = getComputedStyle(node);
            if (st.pointerEvents === 'none') return true;
            if (st.cursor === 'not-allowed') return true;
            if (parseFloat(st.opacity || '1') < 0.5) return true;
        }
        return false;
    }

    // 返回课程目录页（直接跳转，避免 history.back 退回上一节导致重复作答）
    async function backToCourse() {
        if (isStopped()) { log('检测到停止指令，不返回目录'); return; }
        const state = loadState();
        state.phase = 'course';
        state.currentTask = '';
        saveState(state);
        if (CFG.coursePagePattern.test(location.href)) return runCoursePage();
        if (state.courseUrl) { location.href = state.courseUrl; return; }
        if (window.history.length > 1) window.history.back();
        else window.close();
    }

    /* ===================== 悬浮面板（可拖动 / 可缩放 / 可最小化成图标） ===================== */
    function makeDraggable(panel, handle) {
        let dragging = false, startX = 0, startY = 0, startLeft = 0, startTop = 0;
        handle.addEventListener('mousedown', (e) => {
            if (e.target.closest('button, select, input')) return;
            dragging = true;
            const rect = panel.getBoundingClientRect();
            panel.style.left = rect.left + 'px';
            panel.style.top = rect.top + 'px';
            panel.style.right = 'auto';
            startX = e.clientX; startY = e.clientY;
            startLeft = rect.left; startTop = rect.top;
            e.preventDefault();
        });
        document.addEventListener('mousemove', (e) => {
            if (!dragging) return;
            const L = Math.min(Math.max(0, startLeft + e.clientX - startX), window.innerWidth - 80);
            const T = Math.min(Math.max(0, startTop + e.clientY - startY), window.innerHeight - 40);
            panel.style.left = L + 'px';
            panel.style.top = T + 'px';
        });
        document.addEventListener('mouseup', () => { dragging = false; });
    }

    function createMinBall() {
        let ball = document.getElementById('weauto-ball');
        if (ball) return ball;
        ball = document.createElement('div');
        ball.id = 'weauto-ball';
        ball.title = '展开面板';
        ball.style.cssText = `
            position:fixed; right:24px; bottom:24px; z-index:999999;
            width:48px; height:48px; border-radius:50%;
            background:linear-gradient(135deg,#e6432d,#ff8a5c);
            box-shadow:0 4px 14px rgba(0,0,0,.3);
            display:flex; align-items:center; justify-content:center;
            cursor:pointer; user-select:none;`;
        ball.innerHTML = `
            <svg width="24" height="24" viewBox="0 0 24 24" fill="none">
                <path d="M3 17.25V21h3.75L17.8 9.94l-3.75-3.75L3 17.25z" fill="#fff"/>
                <path d="M20.7 7.04a1 1 0 0 0 0-1.41l-2.34-2.34a1 1 0 0 0-1.41 0l-1.83 1.83 3.75 3.75 1.83-1.83z" fill="#fff"/>
            </svg>`;
        ball.onclick = () => {
            const panel = document.getElementById('weauto-panel');
            if (panel) panel.style.display = 'block';
            ball.remove();
        };
        document.body.appendChild(ball);
        return ball;
    }

    // 面板背景：整张背景图铺满弹窗，配合轻微虚化，文字直接压在图上（单文件脚本内嵌 data URI）。
    const PANEL_BG_URI = 'data:image/jpeg;base64,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';

    function buildPanel() {
        if (document.getElementById('weauto-panel')) return;
        const panel = document.createElement('div');
        panel.id = 'weauto-panel';
        panel.style.cssText = `
            position:fixed; top:60px; right:20px; z-index:999999; isolation:isolate;
            width:372px; min-width:320px; min-height:200px;
            max-width:92vw; max-height:88vh; min-height:auto;
            border-radius:18px;
            background-color:rgba(16,22,36,.30);
            box-shadow:0 10px 30px rgba(0,0,0,.38), inset 0 0 0 1px rgba(255,255,255,.28);
            padding:0;
            font:13px/1.5 "Microsoft YaHei",sans-serif;
            color:#fff;
            text-shadow:0 1px 3px rgba(0,0,0,.75), 0 0 1px rgba(0,0,0,.9);
            resize:both; overflow:hidden;`;

        panel.innerHTML = `
            <div id="weauto-header" style="
                display:flex;align-items:center;justify-content:space-between;
                padding:14px 16px 8px;cursor:move;user-select:none;
                background:transparent;border-radius:18px 18px 0 0;color:#fff;">
                <span style="font-weight:bold;font-size:17px;letter-spacing:.5px;
                    text-shadow:0 2px 6px rgba(0,0,0,.85);">哄尖尖老师专用 ${VERSION}</span>
                <button id="weauto-min" title="最小化" style="
                    background:rgba(255,255,255,.22);border:1px solid rgba(255,255,255,.30);color:#fff;
                    width:26px;height:26px;border-radius:50%;cursor:pointer;
                    font-size:15px;line-height:1;padding:0;text-shadow:none;">–</button>
            </div>
            <div style="padding:4px 14px 12px;overflow-y:auto;max-height:calc(88vh - 96px);scrollbar-width:thin;">
                <div style="border:1px solid rgba(255,255,255,.22);border-radius:14px;margin:0 0 10px 0;padding:10px;
                    background:rgba(18,26,42,.52);-webkit-backdrop-filter:blur(6px);backdrop-filter:blur(6px);">
                    <div style="font-size:12px;color:rgba(255,255,255,.82);margin:0 0 8px 2px;font-weight:600;">模型配置</div>
                    <div style="display:flex;gap:8px;margin-bottom:8px;">
                        <select id="weauto-provider" style="flex:1;background:rgba(255,255,255,.42);color:#fff;border:1px solid rgba(255,255,255,.42);
                            border-radius:8px;padding:7px 8px;font-size:13px;cursor:pointer;text-shadow:0 1px 2px rgba(0,0,0,.9),0 0 3px rgba(0,0,0,.55);">
                            <option value="deepseek" style="background:#1b2334;color:#fff;">deepseek</option>
                            <option value="openai" style="background:#1b2334;color:#fff;">openai</option>
                            <option value="custom" style="background:#1b2334;color:#fff;">自定义</option>
                        </select>
                        <input id="weauto-model" list="weauto-models" placeholder="模型名" style="flex:1;min-width:0;
                            background:rgba(255,255,255,.42);color:#fff;border:1px solid rgba(255,255,255,.42);border-radius:8px;padding:7px 8px;font-size:13px;text-shadow:0 1px 2px rgba(0,0,0,.9),0 0 3px rgba(0,0,0,.55);">
                        <datalist id="weauto-models"></datalist>
                    </div>
                    <input id="weauto-baseurl" placeholder="接口地址(自定义厂商时填)" style="display:none;width:100%;box-sizing:border-box;
                        background:rgba(255,255,255,.42);color:#fff;border:1px solid rgba(255,255,255,.42);border-radius:8px;padding:7px 8px;font-size:13px;text-shadow:0 1px 2px rgba(0,0,0,.9),0 0 3px rgba(0,0,0,.55);margin-bottom:8px;">
                    <input id="weauto-apikey" type="password" placeholder="API Key" style="width:100%;box-sizing:border-box;
                        background:rgba(255,255,255,.42);color:#fff;border:1px solid rgba(255,255,255,.42);border-radius:8px;padding:8px 10px;font-size:13px;text-shadow:0 1px 2px rgba(0,0,0,.9),0 0 3px rgba(0,0,0,.55);margin-bottom:10px;">
                    <div style="display:flex;gap:8px;align-items:center;">
                        <button id="weauto-savecfg" style="border:1px solid rgba(255,255,255,.42);border-radius:8px;padding:7px 16px;cursor:pointer;
                            background:rgba(255,255,255,.42);color:#fff;font-size:13px;text-shadow:0 1px 2px rgba(0,0,0,.9),0 0 3px rgba(0,0,0,.55);">保存配置</button>
                        <button id="weauto-testcfg" style="border:1px solid rgba(255,255,255,.42);border-radius:8px;padding:7px 16px;cursor:pointer;
                            background:rgba(255,255,255,.42);color:#fff;font-size:13px;text-shadow:0 1px 2px rgba(0,0,0,.9),0 0 3px rgba(0,0,0,.55);">测试连接</button>
                        <span id="weauto-cfgstatus" style="font-size:12px;color:#7dffa6;font-weight:600;text-shadow:0 1px 2px rgba(0,0,0,.9),0 0 3px rgba(0,0,0,.55);"></span>
                    </div>
                </div>

                <div style="margin-bottom:10px;background:rgba(18,26,42,.52);border-radius:12px;padding:9px 12px;
                    -webkit-backdrop-filter:blur(6px);backdrop-filter:blur(6px);display:flex;align-items:center;gap:8px;">
                    <span style="font-size:13px;color:#fff;white-space:nowrap;">起始单元:</span>
                    <select id="weauto-unit" style="flex:1;background:rgba(255,255,255,.42);color:#fff;border:1px solid rgba(255,255,255,.42);
                        border-radius:8px;padding:6px 8px;font-size:13px;cursor:pointer;text-shadow:0 1px 2px rgba(0,0,0,.9),0 0 3px rgba(0,0,0,.55);"></select>
                </div>
                <div style="margin-bottom:10px;background:rgba(18,26,42,.52);border-radius:12px;padding:9px 12px;
                    -webkit-backdrop-filter:blur(6px);backdrop-filter:blur(6px);display:flex;gap:8px;">
                    <button id="weauto-start" style="flex:1;background:rgba(217,68,42,.72);color:#fff;border:1px solid rgba(255,255,255,.22);border-radius:9px;
                        padding:9px 12px;cursor:pointer;font-size:14px;font-weight:bold;text-shadow:0 1px 3px rgba(0,0,0,.75);
                        -webkit-backdrop-filter:blur(3px);backdrop-filter:blur(3px);">开始自动完成</button>
                    <button id="weauto-stop" style="background:rgba(255,255,255,.42);color:#fff;border:1px solid rgba(255,255,255,.42);border-radius:9px;
                        padding:9px 18px;cursor:pointer;font-size:14px;text-shadow:0 1px 2px rgba(0,0,0,.9),0 0 3px rgba(0,0,0,.55);">停止</button>
                </div>
                <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:6px;
                    background:rgba(18,26,42,.52);border-radius:12px;padding:6px 12px;
                    -webkit-backdrop-filter:blur(6px);backdrop-filter:blur(6px);">
                    <span style="font-size:13px;color:#fff;">运行日志</span>
                    <span style="display:flex;gap:6px;">
                        <button id="weauto-copylog" style="border:1px solid rgba(255,255,255,.42);border-radius:7px;padding:4px 12px;font-size:12px;cursor:pointer;
                            background:rgba(255,255,255,.42);color:#fff;text-shadow:0 1px 2px rgba(0,0,0,.9),0 0 3px rgba(0,0,0,.55);">复制</button>
                        <button id="weauto-clearlog" style="border:1px solid rgba(255,255,255,.35);border-radius:7px;padding:4px 12px;font-size:12px;cursor:pointer;
                            background:rgba(255,255,255,.42);color:#fff;text-shadow:0 1px 2px rgba(0,0,0,.9),0 0 3px rgba(0,0,0,.55);">清空</button>
                    </span>
                </div>
                <div id="weauto-log" style="height:180px;overflow-y:auto;background:rgba(12,18,30,.72);
                    border:1px solid rgba(255,255,255,.42);border-radius:12px;padding:10px;font-size:12px;line-height:1.7;
                    color:#eef3f8;user-select:text;-webkit-user-select:text;cursor:text;text-shadow:0 1px 2px rgba(0,0,0,.85);"></div>
            </div>`;
        document.body.appendChild(panel);

        // 背景虚化层：整图铺满 + 轻微模糊，独立于文字，保证文字清晰
        (function addBlurLayer() {
            panel.style.backgroundImage = 'none';   // 背景改由内层承担，便于单独模糊
            const old = panel.querySelector('.weauto-bg');
            if (old) old.remove();
            const layer = document.createElement('div');
            layer.className = 'weauto-bg';
            layer.style.cssText = 'position:absolute;inset:-3px;z-index:0;pointer-events:none;' +
                'background-image:url("' + PANEL_BG_URI + '");' +
                'background-size:cover;background-position:center 32%;background-repeat:no-repeat;' +
                'border-radius:18px;filter:blur(1.2px);';
            panel.insertBefore(layer, panel.firstChild);
            // 内容层提到背景之上
            [...panel.children].forEach(c => {
                if (c === layer) return;
                c.style.position = c.style.position || 'relative';
                c.style.zIndex = '1';
            });
        })();

        // 日志复制 / 清空
        panel.querySelector('#weauto-copylog').onclick = async () => {
            const box = panel.querySelector('#weauto-log');
            const text = [...box.children].map(d => d.textContent).join('\n');
            try {
                await navigator.clipboard.writeText(text);
                log('日志已复制到剪贴板');
            } catch (e) {
                const range = document.createRange();
                range.selectNodeContents(box);
                const sel = window.getSelection();
                sel.removeAllRanges();
                sel.addRange(range);
                log('复制失败，已全选日志，请按 Ctrl+C');
            }
        };
        panel.querySelector('#weauto-clearlog').onclick = () => {
            panel.querySelector('#weauto-log').innerHTML = '';
        };

        makeDraggable(panel, panel.querySelector('#weauto-header'));
        panel.querySelector('#weauto-min').onclick = () => {
            panel.style.display = 'none';
            createMinBall();
        };

        // 面板内输入框的占位符在深色透明底上默认太淡，单独调亮
        if (!document.getElementById('weauto-style')) {
            const st = document.createElement('style');
            st.id = 'weauto-style';
            st.textContent = '#weauto-panel input::placeholder{color:rgba(255,255,255,.78)!important;opacity:1;}'
                + '#weauto-panel select option{background:#1b2334;color:#fff;}';
            document.head.appendChild(st);
        }

        /* ---- 模型配置区逻辑 ---- */
        const $ = (id) => panel.querySelector(id);
        const providerSel = $('#weauto-provider');
        const modelInput = $('#weauto-model');
        const baseURLInput = $('#weauto-baseurl');
        const apiKeyInput = $('#weauto-apikey');
        const cfgStatus = $('#weauto-cfgstatus');

        function refreshModelPlaceholder() {
            const p = PROVIDERS[providerSel.value];
            modelInput.placeholder = p.defaultModel || '模型名';
            baseURLInput.style.display = providerSel.value === 'custom' ? 'block' : 'none';
            const dl = panel.querySelector('#weauto-models');
            dl.innerHTML = '';
            (p.models || []).forEach(m => {
                const o = document.createElement('option');
                o.value = m;
                dl.appendChild(o);
            });
        }
        providerSel.onchange = refreshModelPlaceholder;
        refreshModelPlaceholder();

        const saved = loadLLMConfig();
        if (saved) {
            providerSel.value = saved.provider || 'deepseek';
            refreshModelPlaceholder();
            let model = saved.model || '';
            if (model === 'deepseek-v4.1-flash-1017') {
                model = PROVIDERS[providerSel.value]?.defaultModel || '';
                saved.model = model;
                saveLLMConfig(saved);
                log(`旧模型名已废弃，自动迁移为 ${model}`);
            }
            modelInput.value = model;
            baseURLInput.value = saved.baseURL || '';
            apiKeyInput.value = saved.apiKey || '';
            cfgStatus.textContent = '已配置';
            cfgStatus.style.color = '#7dffa6';
        }

        $('#weauto-savecfg').onclick = () => {
            const conf = {
                provider: providerSel.value,
                model: modelInput.value.trim() || PROVIDERS[providerSel.value].defaultModel,
                baseURL: baseURLInput.value.trim(),
                apiKey: apiKeyInput.value.trim(),
            };
            if (!conf.apiKey) { cfgStatus.textContent = '请填写 API Key'; cfgStatus.style.color = '#ffb3b3'; return; }
            saveLLMConfig(conf);
            cfgStatus.textContent = '已保存';
            cfgStatus.style.color = 'green';
            log(`模型配置已保存: ${conf.provider} / ${conf.model}`);
        };

        $('#weauto-testcfg').onclick = async () => {
            $('#weauto-savecfg').click();
            cfgStatus.textContent = '测试中…';
            cfgStatus.style.color = 'rgba(255,255,255,.85)';
            try {
                await llmRequest([
                    { role: 'system', content: '只返回JSON对象 {"ok":true}，不要返回其他内容。' },
                    { role: 'user', content: 'ping' },
                ]);
                cfgStatus.textContent = '连接成功';
                cfgStatus.style.color = 'green';
                log('模型连接测试成功');
            } catch (e) {
                cfgStatus.textContent = '连接失败';
                cfgStatus.style.color = 'red';
                log('模型连接测试失败:', e.message);
            }
        };

        /* ---- 单元选择与开始/停止 ---- */
        const sel = $('#weauto-unit');
        getUnitHeaders().forEach((u, i) => {
            const opt = document.createElement('option');
            opt.value = i;
            opt.textContent = textOf(u).replace(/已完成.*$/s, '').slice(0, 30);
            sel.appendChild(opt);
        });
        if (sel.options.length === 0) {
            const opt = document.createElement('option');
            opt.value = 0; opt.textContent = '（未检测到单元）';
            sel.appendChild(opt);
        }

        $('#weauto-start').onclick = () => {
            if (!loadLLMConfig()?.apiKey) {
                log('警告：未配置 API Key，将使用兜底答案（不保证正确率）');
            }
            STOP_FLAG = false;
            const old = loadState();
            const isCoursePage = CFG.coursePagePattern.test(location.href);
            const state = {
                running: true,
                unitIndex: parseInt(sel.value, 10) || 0,
                phase: 'course',
                done: old.done || {},     // 保留已完成记录，重跑时自动跳过
                courseUrl: isCoursePage ? location.href : (old.courseUrl || ''),
                currentTask: '',
                pendingList: [],
            };
            // 【修复】重新开始时清掉上一轮"已遍历到哪个单元"的记录，保证从选定单元完整跑到最后一个单元
            delete state.unitNo;
            saveState(state);
            saveTraverse({ visited: {} });
            log(`开始运行：从第 ${state.unitIndex + 1} 个单元的【第一个未完成开放练习】起按顺序执行`);
            if (!isCoursePage) {
                log('当前不在课程目录页，正在返回目录页…');
                guard(backToCourse());
                return;
            }
            guard(runCoursePageAllUnits());   // 【修复】改用可遍历到最后一个单元的目录流程
        };
        $('#weauto-stop').onclick = () => {
            STOP_FLAG = true;
            const st = loadState();
            st.running = false;
            saveState(st);
            log('已强制停止：当前流程立即中止，不再提交/跳节，也不会自动续跑');
        };
    }

    /* ===================== 目录页主流程 ===================== */
    async function runCoursePage() {
        await sleep(CFG.pageSettleDelay);
        let state = loadState();
        if (!state.running) return;

        const units = getUnitHeaders();
        if (!units.length) {
            log('未检测到单元列表，任务结束');
            state.running = false;
            saveState(state);
            return;
        }

        const allRows = findPracticeRows(units[0].ownerDocument);
        log(`检测到单元 ${units.length} 个，练习行共 ${allRows.length} 个`);
        if (!allRows.length) {
            log('!! 未找到练习行，请确认当前页面是课程目录且单元已展开');
        } else {
            log(`练习行样本: ${textOf(allRows[0]).replace(/\s+/g, ' ').slice(0, 80)}`);
        }

        // 从当前单元开始，找到第一个存在"未完成开放练习"的单元
        let guard = 0;
        while (guard++ < units.length + 2 && state.unitIndex < units.length) {
            if (isStopped()) { log('检测到停止指令，中止目录流程'); return; }
            await expandUnit(state.unitIndex);
            await sleep(600);

            const pending = pendingRowsOfUnit(state.unitIndex);
            if (!pending.length) {
                log(`Unit ${state.unitIndex + 1} 没有待完成的开放练习，进入下一单元`);
                state.unitIndex++;
                saveState(state);
                continue;
            }

            // 总是从该单元第一个未完成的开放练习开始
            const row = pending[0];
            const key = rowKey(row);
            state.pendingList = pending.map(rowKey);
            state.currentTask = key;
            state.phase = 'exercise';
            saveState(state);
            log(`本单元待完成 ${pending.length} 个，先做第 1 个`);
            if (isStopped()) { log('检测到停止指令，不进入练习'); return; }
            clickRow(row);
            return;
        }

        log('所有单元处理完毕，任务结束！');
        state.running = false;
        saveState(state);
    }

    /* ===================== 练习页主流程 ===================== */
    function findButtonByText(texts) {
        for (const doc of getDocuments()) {
            const els = [...doc.querySelectorAll('button, a, input[type=button], input[type=submit], span[onclick], div[onclick]')];
            const hits = els.filter(el => {
                if (el.closest('#weauto-panel, #weauto-overlay, #weauto-ball')) return false;
                if (el.disabled) return false;
                const r = el.getBoundingClientRect();
                if (r.width === 0 && r.height === 0) return false;
                const t = (textOf(el) || el.value || '').toLowerCase();
                return t && texts.some(x => t.includes(x.toLowerCase()));
            });
            if (!hits.length) continue;
            // 优先精确匹配，其次取最短文本（避免命中包住整个工具栏的父容器）
            const exact = hits.find(el => {
                const t = (textOf(el) || el.value || '').toLowerCase().trim();
                return texts.some(x => t === x.toLowerCase());
            });
            if (exact) return exact;
            hits.sort((a, b) => (textOf(a) || '').length - (textOf(b) || '').length);
            return hits[0];
        }
        return null;
    }

    // 找到"习题答案只能提交一次，您确定现在提交吗？"弹窗里的「是」按钮
    function findDialogConfirmButton() {
        const YES = ['是', '确定', '确认', '确定提交', 'yes', 'ok'];
        for (const doc of getDocuments()) {
            const nodes = [...doc.querySelectorAll('div, section, table, form')].filter(el => {
                const t = textOf(el);
                return /只能提交一次|确定现在提交|确定要提交|确定提交吗/.test(t) && t.length < 400;
            });
            nodes.sort((a, b) => textOf(a).length - textOf(b).length); // 从最小容器往外找
            for (const node of nodes) {
                let scope = node;
                for (let up = 0; up < 5 && scope; up++) {
                    const btns = [...scope.querySelectorAll('button, a, input, span, div')].filter(b => {
                        const t = (textOf(b) || b.value || '').trim().toLowerCase();
                        if (!YES.includes(t)) return false;
                        const r = b.getBoundingClientRect();
                        return r.width > 0 && r.height > 0;
                    });
                    if (btns.length) {
                        const inner = btns.filter(b => !btns.some(o => o !== b && b.contains(o)));
                        return inner[0] || btns[0];
                    }
                    scope = scope.parentElement;
                }
            }
        }
        return null;
    }

    // 处理提交后的确认弹窗（点「是」）
    async function handleConfirmDialog() {
        let clicked = 0;
        for (let round = 0; round < 8; round++) {
            const btn = findDialogConfirmButton();
            if (btn) {
                if (clicked >= 3) break;          // 防止点不完的死循环
                log(`检测到确认弹窗，点击「${textOf(btn)}」`);
                realClick(btn);
                clicked++;
                await sleep(1000);
                continue;
            }
            if (clicked) break;                   // 已点过且弹窗消失
            await sleep(500);                     // 弹窗可能稍后才出现
        }
        return clicked > 0;
    }

    // 等待题目内容就绪（段落匹配 / 黄空 / 通用控件），最多重试若干轮
    async function waitForContent() {
        for (let i = 0; i < CFG.contentWaitRounds; i++) {
            if (isStopped()) return null;
            // 划线词辨析要最先判：它靠指令文本/划线元素识别，容易被其它题型误抢
            if (looksLikeUnderlineChoice()) return { type: 'underline', count: findUnderlineItems().length };
            if (looksLikeMatching()) return { type: 'matching', count: findMatchItems().length };
            if (looksLikeRewrite()) return { type: 'rewrite', count: findRewriteInputs().length };
            // 可编辑 input 的填空：先区分语法填空(带括号提示词)/自由输入，再落到选词填空
            const free = findFreeInputs();
            if (free.length) {
                // 复合词构词法：括号里是"两个词根"，优先级高于语法填空(单个词根)
                if (looksLikeCompoundFill()) return { type: 'compound', count: findCompoundItems().length };
                const type = grammarHint(sentenceFor(free[0], 1), 1) ? 'grammar' : 'free';
                return { type, count: free.length };
            }
            const blanks = findAllBlanks();
            if (blanks.length) return { type: 'cloze', count: blanks.length };
            const qs = extractQuestions();
            if (qs.length) return { type: 'generic', count: qs.length };
            log(`等待题目加载…(${i + 1}/${CFG.contentWaitRounds})`);
            await sleep(CFG.contentWaitInterval);
        }
        return null;
    }

    async function doAnswer() {
        if (isStopped()) return;
        // 划线词词义辨析选择题：先判（指令文本 / 划线元素 + A-D 选项组），
        // 必须排在其它题型之前，否则会被通用题型的单选框逻辑抢走
        if (looksLikeUnderlineChoice()) {
            if (await fillUnderlineChoice()) return;
            log('划线词辨析题型处理失败，本页跳过自动作答');
            return;
        }

        // 题型判定：先看是否是"段落匹配"（文章带 Para 标记，或「?」空盒 + 答题提示文字）
        if (looksLikeMatching()) {
            if (await fillMatching()) return;
            log('段落匹配题型处理失败，本页跳过自动作答');
            return;
        }

        if (await fillRewrite()) return;

        // 复合词构词法填空：必须在语法填空之前判（两者都是空盒，靠括号内词根数区分）
        if (await fillCompound()) return;

        if (await fillGrammar()) return;

        if (await fillWordBank()) return;

        if (await fillFreeInput()) return;

        if (await fillCloze()) return;

        const llmConf = loadLLMConfig();
        const questions = extractQuestions();
        if (questions.length === 0) {
            log('未识别到任何题型，使用兜底作答');
            fallbackAnswer();
            return;
        }
        if (llmConf && llmConf.apiKey) {
            log(`提取到 ${questions.length} 道题目，请求大模型作答…`);
            try {
                const answers = await llmAnswerGeneric(questions);
                applyAnswers(questions, answers);
            } catch (e) {
                log('大模型作答失败:', e.message, '—— 回退到兜底作答');
                fallbackAnswer();
            }
        } else {
            log('未配置大模型，使用兜底作答');
            fallbackAnswer();
        }
    }

    async function runExercisePage() {
        await sleep(CFG.pageSettleDelay);
        const state = loadState();
        if (!state.running || state.phase !== 'exercise') return;

        // 防死循环：连续两次停留在同一练习页（「下节」点击无效等），回主界面换下一个练习
        const curKey = resolveCurrentTaskKey();
        if (curKey && state.lastPageKey === curKey) state.samePageCount = (state.samePageCount || 0) + 1;
        else state.samePageCount = 0;
        state.lastPageKey = curKey;
        saveState(state);
        if (state.samePageCount >= 2) {
            log('!! 连续停留在同一页，返回主界面进入下一个未完成练习');
            state.samePageCount = 0;
            saveState(state);
            return backToCourse();
        }

        log('练习页已加载:', location.href.slice(0, 80));

        // 等待并识别题目内容
        const found = await waitForContent();
        if (!found) {
            // 连续 2 次识别不到就跳过该节，避免死循环
            const key = resolveCurrentTaskKey() || state.currentTask;
            if (key) {
                const st = loadState();
                st.failCount = st.failCount || {};
                st.failCount[key] = (st.failCount[key] || 0) + 1;
                saveState(st);
                if (st.failCount[key] >= 2) {
                    markTaskDone(key);
                    log('!! 该节连续 2 次未识别到题目，已跳过:', key.slice(0, 60));
                }
            }
            log('!! 本页未识别到题目内容（可能该节未开放），返回课程目录继续下一个练习');
            return backToCourse();
        }
        const TYPE_LABEL = { cloze: '选词填空', matching: '段落匹配', grammar: '语法填空', free: '自由输入填空', rewrite: '句子改写', underline: '划线词辨析', compound: '复合词填空', generic: '通用题型' };
        log(`题目识别成功: ${TYPE_LABEL[found.type] || '通用题型'}，数量 ${found.count}`);

        // 答案回顾/已完成页：没有 ? 空盒。不在回顾页点「下节」（可能无效导致死循环），
        // 直接回主界面（课程目录），由目录流程进入下一个开放且未完成的练习
        const reviewPage = found.type === 'matching' &&
            !findQuestionBoxes().some(b => /^(\?|？)$/.test(textOf(b).trim()));
        if (reviewPage) {
            log('本页为答案回顾/已完成页（无 ? 空盒），返回主界面进入下一个未完成练习');
            return backToCourse();
        }

        await doAnswer();
        await sleep(CFG.stepDelay);
        if (isStopped()) { log('检测到停止指令，中止流程'); return; }

        const submitBtn = findButtonByText(CFG.submitTexts);
        if (submitBtn) {
            const isMatchingNow = found.type === 'matching';
            const isUnderlineNow = found.type === 'underline';
            if (isMatchingNow || isUnderlineNow) startIncompleteHintWatch();   // 盯住"还有N题未完成"的提示
            log('点击提交(Submit)');
            realClick(submitBtn);
            await sleep(900);
            let confirmed = await handleConfirmDialog();
            let left = (isMatchingNow || isUnderlineNow) ? hintLeft() : -1;
            // 段落匹配兜底：站点提示"还有N题未完成"说明有陈述没被登记
            // （旧版只把文字写进蓝盒就会出现这种情况）。这里逐题点开核对并补选，然后重新提交，最多 2 轮。
            for (let round = 0; round < 2 && !confirmed && isMatchingNow; round++) {
                if (isStopped()) break;
                if (left < 0) break;   // 没有"未完成"提示，不是这个原因
                log(`!! 页面提示还有 ${left} 题未完成，逐题核对段落选中状态后重新提交`);
                const fixed = await repairMatchingSelection();
                if (!fixed) { log('!! 仍有陈述无法在选项栏中选中，需人工处理该题'); break; }
                const again = findButtonByText(CFG.submitTexts);
                if (!again) break;
                log('点击提交(Submit)');
                realClick(again);
                await sleep(900);
                confirmed = await handleConfirmDialog();
                left = hintLeft();
                if (confirmed) { log('补选后提交成功'); break; }
            }
            // 划线词辨析兜底：同样可能因为某题没点中被拒，逐题核对补选后重交
            for (let round = 0; round < 2 && !confirmed && isUnderlineNow; round++) {
                if (isStopped()) break;
                if (left < 0) break;
                log(`!! 页面提示还有 ${left} 题未完成，逐题核对选项选中状态后重新提交`);
                if (!(await repairUnderlineSelection())) { log('!! 仍有题目无法选中，需人工处理'); break; }
                const again = findButtonByText(CFG.submitTexts);
                if (!again) break;
                log('点击提交(Submit)');
                realClick(again);
                await sleep(900);
                confirmed = await handleConfirmDialog();
                left = hintLeft();
                if (confirmed) { log('补选后提交成功'); break; }
            }
            if (isMatchingNow || isUnderlineNow) stopIncompleteHintWatch();
            log(confirmed ? '已确认提交' : '未检测到确认弹窗，按已提交处理');
            await sleep(CFG.stepDelay * 2);
        } else {
            log('未找到提交按钮（本节可能无需提交）');
        }

        if (isStopped()) { log('检测到停止指令，中止流程'); return; }

        // 记录当前这一节已完成
        const doneKey = resolveCurrentTaskKey();
        if (doneKey) {
            markTaskDone(doneKey);
            // 【修复】本节真的做完后，清空"连续识别失败"计数，否则整个运行周期共用一份计数，
            // 到后面单元（Unit 7/8）时计数被填满，会让判定提前走"跳过"分支
            const stAfter = loadState();
            stAfter.failCount = {};
            saveState(stAfter);
            log('已记录完成:', doneKey.slice(0, 60));
        }

        // 不再点击「下节」：提交后直接退回主界面（课程目录），
        // 由目录流程依次展开单元、检索下一个开放且未完成的练习继续作答
        log('本节完成，返回主界面检索下一个未完成练习');
        return backToCourse();
    }

    /* ===================== 入口 ===================== */
    async function main() {
        await sleep(1200);
        const state = loadState();

        if (CFG.coursePagePattern.test(location.href)) {
            buildPanel();
            if (state.running && state.phase === 'course') {
                log('检测到未完成任务，自动继续…');
                guard(runCoursePageAllUnits());   // 【修复】续跑同样遍历到最后一个单元
            }
        } else {
            // 非目录页（练习页等）也显示控制面板，便于随时调整配置或停止
            buildPanel();
            if (state.running && state.phase === 'exercise') {
                guard(runExercisePage());
            }
        }
    }

    if (document.readyState === 'complete') guard(main());
    else window.addEventListener('load', () => guard(main()));
})();

