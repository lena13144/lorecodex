import fs from 'fs';
import path from 'path';
import { execFileSync, spawnSync } from 'child_process';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function detectPythonBin() {
  const envBin = String(process.env.PYTHON_BIN || '').trim();
  if (envBin) return envBin;
  const candidates = process.platform === 'win32' ? ['python', 'python3', 'py'] : ['python3', 'python'];
  for (const cmd of candidates) {
    try {
      const res = spawnSync(cmd, ['-c', 'import sys; print(sys.version_info[0])'], {
        encoding: 'utf8',
        timeout: 3000,
        windowsHide: true,
      });
      if (res.status === 0 && String(res.stdout || '').trim() === '3') return cmd;
    } catch (_) {}
  }
  return process.platform === 'win32' ? 'python' : 'python3';
}

const PYTHON_BIN = detectPythonBin();

const ROOT = path.resolve(__dirname, '..');
const EX_DIR = path.join(ROOT, 'examples', 'demo-chronicles');
const CORPUS_DIR = path.join(ROOT, 'corpora', 'demo-chronicles');

const CHRONICLES_TXT = `# 第一卷：灰烬星港的雨夜

## 第1章 星港迫降与霜刃初现
暴雨砸在灰烬星港第三停机坪的玄武岩甲板上，水花溅湿了林渊破旧的黑风衣。右臂的机械义体发出低沉的电流嗡鸣，代号“霜刃”的战术目镜在雨幕中闪过一抹淡蓝冷光。

三年前那场轨道轰炸后，星港下层区彻底沦为走私贩与猎人的灰色巢穴。林渊握紧腰间的脉冲短刃，视线穿过倾泻的雨帘，锁定了停泊在七号泊位的银灰色货船。

“欢迎回到泥潭，Zero-7。”通讯频道里传来一个略带沙哑的女声。苏璃靠在货船舷梯旁，银色短发被风吹乱，她手中抛接着一枚刻着星轨编号的黄铜徽章，“星港督察局刚刚封锁了东区通道，你迟到了整整十七分钟。”

林渊踩着水洼走上舷梯，压低声音说道：“半路上遇上了铁鸦帮的巡逻艇。‘银鸢号’的推进器修好了吗？如果天亮前还不能起飞，整条星港都会变成陷阱。”

苏璃没有立刻回答，只是侧身让出通道。舱门合拢的瞬间，警报声突然在远处的高塔上刺耳地拉响。火光冲天而起，东区燃料库被未知火力引燃，热浪顺着排水渠翻涌而来。危机迫在眉睫，林渊反手抽出短刃，挡在苏璃身前准备迎击突围。

## 第2章 旧船长的茶馆与铁匠的酒杯
黎明前的雾气散去后，下层区角落那家没有招牌的暖炉茶馆重新挂出了木牌。炉火噼啪作响，红茶与烤黑麦面包的香气驱散了夜里的硝烟。

陆沉坐在一张摇晃的橡木桌后，慢条斯理地擦拭着他那支早已停产的旧式左轮。自从退役离开“星辰远征舰队”后，这名昔日的旧船长便一直守在这间茶馆里，替来往的流浪者修补无线电台。

“这杯热茶算我请你们的。”陆沉把粗陶杯推到林渊面前，眼角的皱纹在暖光中舒展开来，“昨晚东区那场大火，动静可不小。你们两个小家伙，还是老样子，走到哪儿就把麻烦带到哪儿。”

苏璃笑着捧起陶杯抿了一口，神情难得地放松下来：“总比被困在轨道废墟里强，旧船长。对了，你这里有没有多余的微晶电容？”

柜台最角落的阴影里突然传来一声沉闷的咳嗽。一位醉醺醺的老铁匠卡伦端起酒杯晃了晃，低声插了一句：“微晶电容我这儿倒是有三颗，不过得拿半箱黑麦威士忌来换。另外提醒你们一句，昨晚燃料库里烧掉的根本不是普通货船的油箱，我闻到了皇家研究院才有的蓝磷味儿。”

说完这句话，那名酒客便又低下头去打磨手里的旧齿轮，不再多言。林渊与苏璃对视一眼，茶馆里原本温和的日常氛围瞬间多了一丝沉甸甸的凝重。

## 第3章 议会密令与暗流真相
午夜十二点，星港中枢塔七十二层的档案库内只有指示灯在幽幽闪烁。陆沉凭借早年舰队留下的旧权限卡，替林渊撬开了第三号加密终端。

“看这个。”林渊压低嗓音，手指在光幕上划过一串被抹去日期的航行日志，“三年前轨道灾难的真正起因根本不是海盗袭击，而是上层议会秘密签署了《静默清场协议》。”

光幕投影出几份盖着红漆印章的密令文件，上面赫然出现了星港总督与皇家研究院的联合署名。伪装成救援舰队的重型巡洋舰，实际上奉命封锁了全部逃生通道。

“难怪当年舰队发出求救信号后整整六个小时都没有回应。”陆沉的声音冷得像冰，他死死盯着屏幕角落里的一个编号，“他们在掩盖某种沉睡在星港地底的东西。林渊，这份情报一旦曝光，整座上层议会都会疯了一样追杀我们。”

窗外霓虹闪烁，权谋与背叛的阴影笼罩了整座城市。林渊将日志拷贝进加密晶芯片，心底清楚自己已经没有退路。

# 第二卷：星门深处的回响

## 第4章 轨道废墟的炮火突围
警笛声撕裂了高空大气层，三艘议会重装截击机封堵了七号轨道的出口。炮火在黑曜石般的宇宙虚空中接连炸开，炽白的等离子束擦着“银鸢号”的左翼掠过，整艘船体剧烈震颤。

“左翼护盾只剩百分之十八！”苏璃紧握操纵杆，在密集的弹幕间做了一个近乎垂直的翻滚机动，金属外壳发出令人牙酸的呻吟，“Zero-7，把副炮的能源全部切到主引擎！”

林渊站在炮塔舱口，义体左臂直接接入飞船火控总线。剧烈的过载电弧顺着他的肩胛骨炸开，战术目镜上跳动着密密麻麻的弹道预测线：“还差四秒完成跃迁充能！挺住，别让那群猎犬咬住尾巴！”

一道高能激光贯穿了货舱外装甲，火光瞬间吞没了半侧通道。林渊咬紧牙关手动拉下备用断路闸，巨大的反冲力震飞了通讯耳机。千钧一发之际，主引擎喷出耀眼的蓝色尾焰，“银鸢号”化作一道流星冲破封锁线，一头扎进了深空乱流。

## 第5章 星门密室与苍穹之心
穿越乱流后，“银鸢号”停泊在星图上从未标注过的古代遗迹内部。巨大的环形石壁上刻满了早已失传的星辰铭文，中央祭坛悬浮着一颗散发淡金色光辉的菱形核心。

林渊捂着渗血的肋下走近祭坛，惊讶地发现核心表面的密码锁竟然在回应苏璃胸前那枚黄铜徽章的频率。

“你早就来过这里，对吗？”林渊停下脚步，眼神复杂地看着并肩走来的少女，“从在灰烬星港第一次见面起，你就一直在找这东西。”

苏璃沉默了很久，终于摘下那枚陪了她十几年的徽章，轻轻按在祭坛凹槽里。金色波纹瞬间席卷整座大厅，一段尘封的影像在半空中浮现。

“是时候告诉你全部真相了，林渊。”苏璃转过身，银白色的瞳孔在金光映照下显得格外遥远，“其实我并非普通的星港走私客。苏璃的真实身份是初代星门守望者，而这座祭坛中央的核心密钥名为【苍穹之心】。三年前议会轰炸星港，真正的目的就是为了夺走我体内的守望者密钥，强行重启跨星系星门。”

林渊愣在原地，过往所有的疑团在这一刻全部串联起来——为什么银鸢号能穿行乱流，为什么议会不惜毁掉整座下层区也要活捉她。

## 第6章 黎明前的独自抉择
深夜的甲板上万籁俱寂，只有星门遗迹深处传来如潮汐般温柔的共振声。林渊独自坐在舷梯最高一节台阶上，摘下已经出现裂纹的“霜刃”目镜放在膝头。

海风似的离子流拂过脸颊，他想起三年前从废墟里爬出来时的绝望，想起陆沉茶馆里的热茶，也想起刚才苏璃站在金色光幕前的背影。

“如果重启星门意味着要付出一个时代的代价，我绝不会让议会得逞。”林渊低声自语，手指轻轻抚过腰间那柄跟了自己五年的脉冲短刃。义体关节在寂静中发出轻微的咬合声，他心里从未像此刻这样平静而坚定。

无论前方等待着怎样的风暴，天亮之后，银鸢号都将再次启航。
`;

const WORLDBOOK = {
  entries: {
    '1': {
      uid: 1,
      comment: '银鸢号推进器参数',
      key: ['银鸢号', '推进器', '苏璃'],
      disable: false,
      content: '银鸢号（Silver Kite）是初代守望者时期遗留的高机动侦察护卫舰，核心搭载双联装“风神-IV型”等离子矢量推进器，最大常规巡航加速度 4.2G，过载跃迁充能时间标准值 18 秒（紧急切副炮能源可压缩至 12 秒），左翼护盾极易在强电磁干扰下衰减。',
    },
    '2': {
      uid: 2,
      comment: '星港重力锚协议',
      key: ['灰烬星港', '重力锚', '协议'],
      disable: false,
      content: '灰烬星港由三座环状人工重力锚支撑悬浮于近地轨道边缘。一旦触发《静默清场协议》，中枢塔七十二层可在九十秒内切断下层区七成供电与全部公开航道信标。',
    },
    '3': {
      uid: 3,
      comment: '霜刃义体维护协议',
      key: ['林渊', '霜刃', 'Zero-7', '义体'],
      disable: false,
      content: '林渊所装配的“霜刃”军规级右臂义体原产自远征舰队特种工兵营，内置神经直连火控接口（接口编号 Z7-AR），连续接入高负荷飞船总线超过 6 秒会引起肩胛处过载电弧灼伤，需定期使用冷媒液与微晶电容保养。',
    },
    '4': {
      uid: 4,
      comment: '星辰远征舰队编年纪',
      key: ['陆沉', '旧船长', '星辰远征舰队'],
      disable: false,
      content: '星辰远征舰队曾负责开拓外环星域，三年前轨道轰炸事件后被议会强制拆编。原三号巡洋舰舰长陆沉退役后隐居灰烬星港下层区经营无名暖炉茶馆，暗中保存着一套旧军用权限识别卡。',
    },
    '5': {
      uid: 5,
      comment: '活动数值噪点测试条目',
      key: ['测试'],
      disable: false,
      content: '活动期间累计登录可获赠抽奖券10张，攻击力提高25%，暴击率提高15%，回合最多触发2次，造成120%稳态伤害。',
    },
  },
};

function main() {
  fs.mkdirSync(EX_DIR, { recursive: true });
  fs.mkdirSync(CORPUS_DIR, { recursive: true });

  const txtPath = path.join(EX_DIR, 'chronicles.txt');
  const wbPath = path.join(EX_DIR, 'worldbook.json');
  fs.writeFileSync(txtPath, CHRONICLES_TXT.trim() + '\n', 'utf8');
  fs.writeFileSync(wbPath, JSON.stringify(WORLDBOOK, null, 2) + '\n', 'utf8');

  // Seed main character aliases before build_novel so heuristic builder extracts protagonist characters (while keeping cameo 卡伦 absent)
  fs.writeFileSync(
    path.join(CORPUS_DIR, 'corpus.json'),
    JSON.stringify({ aliases: [['林渊', '霜刃', 'Zero-7'], ['苏璃', '银鸢'], ['陆沉', '旧船长']] }, null, 2),
    'utf8'
  );

  console.log('[create_demo_corpus] building novel tree...');
  execFileSync(
    PYTHON_BIN,
    [
      path.join(ROOT, 'builders', 'build_novel.py'),
      '--input',
      txtPath,
      '--corpus-id',
      'demo-chronicles',
      '--name',
      '星港编年史',
      '--out-dir',
      path.join(ROOT, 'corpora'),
      '--min-chars',
      '200',
      '--target-chars',
      '1800',
      '--max-chars',
      '3600',
      '--no-llm',
    ],
    { stdio: 'inherit' }
  );

  console.log('[create_demo_corpus] merging worldbook lore...');
  execFileSync(
    PYTHON_BIN,
    [
      path.join(ROOT, 'builders', 'build_lore.py'),
      '--input',
      wbPath,
      '--corpus-id',
      'demo-chronicles',
      '--category',
      '档案设定',
      '--series',
      '世界观与技术档案',
      '--merge-into',
      CORPUS_DIR,
      '--filter-game-stats',
      '--no-llm',
    ],
    { stdio: 'inherit' }
  );

  const corpusConfig = {
    id: 'demo-chronicles',
    name: '星港编年史',
    description: '《星港编年史》通用化验证示范语料库（2卷6章长篇小说 + 合并世界观档案，带章节序防剧透门控与别名/客串测试集）。',
    language: 'zh-CN',
    world_premise:
      '当前语料库收录了原创科幻冒险长篇《星港编年史》正文章节及世界观技术档案。请严格依据当前允许进度（maxOrder）内的原文与无剧透限制设定回答问题或辅助扮演。',
    active_recall_triggers:
      '提及角色过往经历、人物真实身份、神秘组织与协议、飞船或义体技术参数、茶馆/星港旧事或询问具体台词',
    skip_criteria:
      '与星港剧情和人物完全无关的日常天气闲聊或纯美食探讨',
    aliases: [
      ['林渊', '霜刃', 'Zero-7'],
      ['苏璃', '银鸢'],
      ['陆沉', '旧船长'],
      ['老铁匠卡伦', '卡伦'],
    ],
    glossary: [
      '- 主角同行组：林渊（代号 霜刃 / Zero-7）、苏璃（银鸢号舰长）',
      '- 下层区协助者：陆沉（退役旧船长，无名暖炉茶馆老板）、老铁匠卡伦（偶居茶馆的醉酒工匠）',
      '- 势力与核心设施：灰烬星港、上层议会、星辰远征舰队、皇家研究院、银鸢号',
    ],
    stage_card_patterns: ['^(?:灰烬星港|星港沙盒)$', '(?:世界|城市|模拟器|舞台|总览|合集|世界书)'],
    user_identity_guard: {
      enabled: true,
      note: '用户身份（玩家本尊，严禁将用户 ID 误认作语料人物去检索）',
    },
    oc_examples: ['莉莉丝', '艾尔莎'],
    tone_routing_hints:
      '语境偏日常温馨回忆时，重点关注含【温情/日常】标签的篇章（如第2章茶馆）；语境偏战斗突围时，重点关注【战斗/危机】篇章（如第1章/第4章）。',
    spoiler_gate: {
      enabled: true,
      order_label: '章节进度',
      default_max_order: null,
    },
    hierarchy: {
      auto_series_threshold: 250,
    },
    grep: {
      english_exclude_terms: ['Silver Kite'],
    },
    prompt_framing: {
      xml_tag: 'chronicles_source_reference',
      header:
        '以下为《星港编年史》中检索并核实的章节原文与技术档案。请将其作为角色回忆或世界常识自然融入扮演，严禁剧透超出当前进度的新章内容。',
      priority_rule:
        '【事实优先级】若原著细节与本局当前对话已确认的发展存在冲突，以本局当前时间线为准。',
    },
    ui: {
      subtitle: '星港编年史 · 通用树检索示范集',
      default_char: '灰烬星港',
      default_user: '旅人',
      presets: [
        {
          label: '防剧透(序<=3)',
          charName: '灰烬星港',
          userName: '旅人',
          maxScenes: 0,
          maxOrder: 3,
          query: '苏璃的真正身份和苍穹之心是什么？',
          onDemand: '',
          recent: '',
        },
        {
          label: '全解锁+技术档',
          charName: '灰烬星港',
          userName: '旅人',
          maxScenes: 0,
          maxOrder: 6,
          query: '',
          onDemand: '苏璃的真正身份以及银鸢号推进器参数',
          recent: '',
        },
        {
          label: '别名/客串查证',
          charName: '灰烬星港',
          userName: '旅人',
          maxScenes: 0,
          maxOrder: 6,
          query: 'Zero-7 和老铁匠卡伦提过什么？',
          onDemand: '',
          recent: '',
        },
      ],
    },
  };

  fs.writeFileSync(path.join(CORPUS_DIR, 'corpus.json'), JSON.stringify(corpusConfig, null, 2) + '\n', 'utf8');

  const graph = [
    { s: '林渊', r: '搭档', o: '苏璃', w: 5 },
    { s: '林渊', r: '旧识', o: '陆沉', w: 3 },
    { s: '苏璃', r: '驾驶', o: '银鸢号', w: 4 },
    { s: '陆沉', r: '曾任舰长', o: '星辰远征舰队', w: 3 },
    { s: '老铁匠卡伦', r: '常驻', o: '暖炉茶馆', w: 2 },
  ];
  fs.writeFileSync(path.join(CORPUS_DIR, 'graph.json'), JSON.stringify(graph, null, 2) + '\n', 'utf8');

  console.log('[create_demo_corpus] DONE ->', CORPUS_DIR);
}

main();
