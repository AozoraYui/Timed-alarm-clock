import common from '../../lib/common/common.js';
import schedule from 'node-schedule';
import moment from 'moment-timezone';

// Redis 键的前缀，方便管理
const ALARM_REDIS_PREFIX = 'alarm:clock:';

export class AlarmClock extends plugin {
  constructor() {
    super({
      name: '定时闹钟',
      dsc: '在指定时间@用户，提醒设定的事项',
      event: 'message',
      priority: 100, // 优先级可以适当调整
      rule: [
        {
          reg: '^#定时(闹钟)?(.*)$',
          fnc: 'setAlarmStep1'
        },
        {
          reg: '^#闹钟(详细)?帮助$',
          fnc: 'alarmHelp'
        },
        {
          reg: '^#闹钟(列表|队列)$',
          fnc: 'listAlarms'
        },
        {
          reg: '^#闹钟取消\\s*(\\d+)$', 
          fnc: 'cancelAlarm'
        },
        {
          reg: '^#全部闹钟(列表|队列)$',
          fnc: 'listAllAlarms',
          permission: 'master'
        }
      ]
    });

    // 使用全局变量作为开关，确保恢复任务只执行一次
    if (!global.ALARM_CLOCK_INITIALIZED) {
      this.restoreAlarmsFromRedis();
      global.ALARM_CLOCK_INITIALIZED = true;
    }
  }
  
  /**
   * 发送帮助信息
   */
  async alarmHelp(e) {
    const isDetailed = e.msg.includes('详细');

    if (isDetailed) {
        // --- 详细版帮助 ---
        const helpMsg = `喵~ 这是超级详细的闹钟使用手册哦！
        
--- 1. 创建闹钟 ---
#定时闹钟 [时间] [@某人]

我能听懂很多种时间说法，用起来非常方便！下面是一些例子：

【常用说法】
#定时闹钟 今天下午3点
#定时闹钟 今晚9点
#定时闹钟 明天晚上8点半
#定时闹钟 明早7点30分
#定时闹钟 后天中午12点

【指定日期】
#定时闹钟 9月12日 早上7:30
#定时闹钟 9月15号上午8点
#定时闹钟 2025年10月1号 16:00
#定时闹钟 2025-11-20 20:00
#定时闹钟 2025/11/20 20:00

【快速设置】 (设置“XX分钟/小时后”)
#定时闹钟 10分钟后
#定时闹钟 半小时后
#定时闹钟 一个半小时后
#定时闹钟 1小时后
#定时闹钟 30分钟后提醒我

【提醒对象】
默认提醒你自己。如果想提醒别人，在时间后面加上 @对方
#定时闹钟 明天下午3点 @张三
#定时闹钟 1小时后 @群友A 别忘了开会

PS：我目前最远只认识到“后天”哦，更远的时间就需要用具体的日期啦~

--- 2. 管理闹钟 ---
【查看本群闹钟队列】
#闹钟列表
#闹钟队列

【按序号取消闹钟】
#闹钟取消 1
(序号在“#闹钟列表”里查看哦~)`;
        await e.reply(helpMsg, true);
    } else {
        // --- 简化版帮助 ---
        const helpMsg = `喵~ 定时闹钟快速上手指南！

--- 创建闹钟 ---
#定时闹钟 [时间] [@某人]
> 示例: #定时闹钟 明天下午3点半
我能听懂“今天/明天/后天”等说法哦~

--- 管理闹钟 ---
#闹钟列表  (查看本群闹钟)
#闹钟取消 [序号] (取消闹钟)

发送 “#闹钟详细帮助” 可查看所有支持的时间格式哦~`;
        await e.reply(helpMsg, true);
    }
    return true;
  }

  /**
   * 获取用户昵称的辅助函数
   */
  async getUserProfile(userId, groupId = null) {
      if (groupId) {
          try {
              const member = await Bot.getGroupMemberInfo(groupId, userId).catch(() => null);
              if (member) {
                  return member.card || member.nickname;
              }
          } catch (error) {}
      }
      try {
          const friend = Bot.fl.get(Number(userId));
          if (friend) {
              return friend.nickname;
          }
      } catch(e) {}
      return userId.toString();
  }

  /**
   * 获取闹钟，可选按群聊过滤
   */
  async getAlarms(group_id = null) {
    let alarms = [];
    let cursor = 0;
    do {
        const result = await redis.scan(cursor, { MATCH: `${ALARM_REDIS_PREFIX}*`, COUNT: 100 });
        cursor = result.cursor;
        const keys = result.keys;

        if (keys && keys.length > 0) {
            for (const key of keys) {
                const alarmDataStr = await redis.get(key);
                if (alarmDataStr) {
                    try {
                        const alarmData = JSON.parse(alarmDataStr);
                        if (group_id && alarmData.group_id != group_id) {
                            continue;
                        }
                        alarms.push(alarmData);
                    } catch (parseError) {
                        logger.error(`[定时闹钟] 解析Redis中的闹钟数据失败, key: ${key}`, parseError);
                    }
                }
            }
        }
    } while (cursor !== 0);

    alarms.sort((a, b) => moment(a.time).valueOf() - moment(b.time).valueOf());
    return alarms;
  }

  /**
   * 查看单个群的闹钟列表
   */
  async listAlarms(e) {
    const alarms = await this.getAlarms(e.group_id);

    if (!alarms || alarms.length === 0) {
        await e.reply('本群当前还没有待执行的闹钟哦~', true);
        return true;
    }

    let forwardMsg = ['本群的闹钟队列如下 (序号按时间顺序排列)：'];
    for (let i = 0; i < alarms.length; i++) {
        const alarm = alarms[i];
        const setterName = await this.getUserProfile(alarm.setter_id, alarm.group_id);
        const targetName = await this.getUserProfile(alarm.target_id, alarm.group_id);
        
        let msg = `${i + 1}. [${moment(alarm.time).format("MM-DD HH:mm")}]
提醒对象：${targetName}
创建人：${setterName}
内容：“${alarm.content}”`;
        forwardMsg.push(msg);
    }

    if (forwardMsg.length > 1) {
        await e.reply(await common.makeForwardMsg(e, forwardMsg, '本群闹钟队列'));
    }
    return true;
  }
  
  /**
   * 查看所有群的闹钟列表 (主人专用)
   */
  async listAllAlarms(e) {
    const allAlarms = await this.getAlarms();

    if (!allAlarms || allAlarms.length === 0) {
        await e.reply('所有群聊中都没有待执行的闹钟哦~', true);
        return true;
    }

    const groupedAlarms = {};
    for (const alarm of allAlarms) {
        if (!groupedAlarms[alarm.group_id]) {
            groupedAlarms[alarm.group_id] = [];
        }
        groupedAlarms[alarm.group_id].push(alarm);
    }

    let forwardMsg = [`为您展示所有群组的闹钟队列，共 ${allAlarms.length} 个任务：`];
    for (const groupId in groupedAlarms) {
        const groupAlarms = groupedAlarms[groupId];
        const group = Bot.gl.get(Number(groupId));
        //在群名后附上群号
        const groupName = group ? `${group.group_name}(${groupId})` : `未知或已退群(${groupId})`;
        
        forwardMsg.push(`--- ${groupName} (${groupAlarms.length}个任务) ---`);

        for (const alarm of groupAlarms) {
            const setterName = await this.getUserProfile(alarm.setter_id, alarm.group_id);
            const targetName = await this.getUserProfile(alarm.target_id, alarm.group_id);
            //在用户名后附上QQ号
            let msg = `[${moment(alarm.time).format("MM-DD HH:mm")}] 提醒 ${targetName}(${alarm.target_id})\n创建人：${setterName}(${alarm.setter_id})\n内容：“${alarm.content}”`;
            forwardMsg.push(msg);
        }
    }
    
    await e.reply(await common.makeForwardMsg(e, forwardMsg, '全部闹钟队列'));
    return true;
  }

  /**
   * 取消闹钟
   */
  async cancelAlarm(e) {
    const index = parseInt(e.msg.match(/#闹钟取消\s*(\d+)/)[1]);
    const alarms = await this.getAlarms(e.group_id);

    if (!index || index <= 0 || index > alarms.length) {
        await e.reply(`序号 [${index}] 不存在哦，请发送 #闹钟列表 查看正确的序号。`, true);
        return true;
    }

    const alarmToCancel = alarms[index - 1];

    if (e.user_id != alarmToCancel.setter_id && !e.isMaster && (!e.member || !e.member.is_admin)) {
        await e.reply('只有闹钟的创建者或群管理员才能取消哦~', true);
        return true;
    }

    const job = schedule.scheduledJobs[alarmToCancel.key];
    if (job) {
        job.cancel();
    }
    
    await redis.del(alarmToCancel.key);
    logger.info(`[定时闹钟] 已成功从内存和Redis中取消闹钟: ${alarmToCancel.key}`);

    await e.reply(`闹钟 [${index}] 已成功取消！\n内容：“${alarmToCancel.content}”`, true);
    return true;
  }

  /**
   * 插件初始化时，从 Redis 中加载并恢复闹钟
   */
  async restoreAlarmsFromRedis() {
    logger.info('[定时闹钟] 开始从 Redis 恢复闹钟任务 (仅执行一次)...');
    let cursor = 0;
    do {
      try {
        const result = await redis.scan(cursor, {
            MATCH: `${ALARM_REDIS_PREFIX}*`,
            COUNT: 100
        });
        
        cursor = result.cursor;
        const keys = result.keys;

        if (keys && keys.length > 0) {
            for (const key of keys) {
                try {
                  const alarmDataStr = await redis.get(key);
                  if (alarmDataStr) {
                    const alarmData = JSON.parse(alarmDataStr);
                    if (moment(alarmData.time).isAfter(moment())) {
                      this.scheduleAlarmJob(alarmData);
                      logger.info(`[定时闹钟] 已恢复闹钟: ${alarmData.group_id} - @${alarmData.target_id}`);
                    } else {
                      await redis.del(key);
                    }
                  }
                } catch (innerError) {
                  logger.error(`[定时闹钟] 处理单个闹钟key失败, key: ${key}, error:`, innerError);
                }
            }
        }
      } catch(scanError) {
          logger.error(`[定时闹钟] Redis scan 操作失败:`, scanError);
          cursor = 0;
      }
    } while (cursor !== 0);
    logger.info('[定时闹钟] 所有历史闹钟任务已恢复完毕');
  }
  
  /**
   * 时间字符串预处理器
   */
  preprocessTimeStr(timeStrRaw) {
    let str = timeStrRaw;
    // 预处理，将模糊时间转为精确时间
    str = str.replace(/今晚/g, '今天晚上');
    str = str.replace(/明晚/g, '明天晚上');
    str = str.replace(/后晚/g, '后天晚上');
    str = str.replace(/今早/g, '今天早上');
    str = str.replace(/明早/g, '明天早上');
    str = str.replace(/后早/g, '后天早上');

    str = str.replace(/号/g, '日');
    str = str.replace(/：|点/g, ':');

    let datePart = '';
    let timePart = str;

    const datePatterns = {
        '后天': moment().add(2, 'days'),
        '明天': moment().add(1, 'days'),
        '今天': moment()
    };
    for (const key in datePatterns) {
        if (timePart.includes(key)) {
            datePart = datePatterns[key].format('YYYY-MM-DD');
            timePart = timePart.replace(key, '').trim();
            break;
        }
    }
    
    if (!datePart) {
      // 优先匹配 YYYY-MM-DD 或 YYYY/MM/DD 格式
      const standardDateMatch = timePart.match(/(\d{4})[-/](\d{1,2})[-/](\d{1,2})/);
      if (standardDateMatch) {
          const dateStr = standardDateMatch[0];
          datePart = moment(dateStr, "YYYY-MM-DD").format("YYYY-MM-DD");
          timePart = timePart.replace(dateStr, '').trim();
      }
    }

    if (!datePart) {
        const match = timePart.match(/(\d{4}年)?(\d{1,2}月)?(\d{1,2}日)/);
        if (match && match[0]) {
            const dateStr = match[0];
            // 检查正则表达式是否捕获到了年份部分 (match[1])
            if (match[1]) { 
                // 如果捕获到了年份 (例如 "2025年"), 使用包含年份的格式
                datePart = moment(dateStr, "YYYY年M月D日").format("YYYY-MM-DD");
            } else {
                // 如果没有捕获到年份 (例如 "10月2日"), 使用不含年份的格式
                datePart = moment(dateStr, "M月D日").format("YYYY-MM-DD");
            }
            timePart = timePart.replace(dateStr, '').trim();
        } else {
            datePart = moment().format('YYYY-MM-DD');
        }
    }

    timePart = timePart.replace(/中午/g, '12:00');
    timePart = timePart.replace(/半/g, '30');

    let isPM = /下午|晚上/.test(timePart);
    timePart = timePart.replace(/凌晨|早上|上午|下午|晚上/g, '').trim();

    // 兼容 H:m 和 H 两种格式
    let hour = 0, minute = 0;
    let timeExplicitlySet = false; // 在这里定义变量并设置初始值为 false

    // 兼容 H:m 和 H 两种格式
    let timeMatch = timePart.match(/(\d{1,2}):(\d{1,2})/); // 优先匹配 H:m
    if (timeMatch) {
        hour = parseInt(timeMatch[1], 10);
        minute = parseInt(timeMatch[2], 10);
        timeExplicitlySet = true; // 找到了时间，把标志设为 true
    } else {
        timeMatch = timePart.match(/(\d{1,2})/); // 降级匹配 H
        if (timeMatch) {
            hour = parseInt(timeMatch[1], 10);
            timeExplicitlySet = true; // 找到了时间，把标志设为 true
        }
    }
    
    // 如果用户没有明确设置任何时间 (标志仍然是 false)，则使用默认值
    if (!timeExplicitlySet) {
        hour = 8; // 默认早上 8 点
        minute = 0;
    }
    
    if (isPM && hour >= 1 && hour < 12) {
        hour += 12;
    }
    
    const finalStr = `${datePart} ${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`;
    return finalStr;
  }

  /**
   * 设置闹钟 - 第一步：解析时间和提醒对象
   */
  async setAlarmStep1(e) {
    let target_id = e.user_id;
    if (e.at && e.at !== e.self_id) {
        target_id = e.at;
    }

    let text_content = '';
    if (e.message) {
      e.message.forEach(seg => {
        if (seg.type === 'text') {
          text_content += seg.text;
        }
      });
    } else {
      text_content = e.raw_message;
    }
    const timeStrRaw = text_content.replace(/^#定时(闹钟)?/, '').trim();
    
    if (!timeStrRaw) {
      e.reply('请输入正确的时间哦！\n发送 #闹钟帮助 可以查看更多信息。', true);
      return true;
    }

    let alarmTime;
    let isRelative = false;

    // --- 唯一修改点 Start ---
    // 预处理 "半小时" 这类自然语言
    let processedTimeStr = timeStrRaw;
    processedTimeStr = processedTimeStr.replace(/一个半小时/g, '90分钟');
    processedTimeStr = processedTimeStr.replace(/半小时/g, '30分钟');
    processedTimeStr = processedTimeStr.replace(/一刻钟/g, '15分钟');

    const minuteMatch = processedTimeStr.match(/(\d+)\s*分钟后/);
    if (minuteMatch) {
        alarmTime = moment().add(parseInt(minuteMatch[1]), 'minutes');
        isRelative = true;
    } else {
        const hourMatch = processedTimeStr.match(/(\d+)\s*小时后/);
        if (hourMatch) {
            alarmTime = moment().add(parseInt(hourMatch[1]), 'hours');
            isRelative = true;
        }
    }
    // --- 唯一修改点 End ---
    
    if (!isRelative) {
        const timeStr = this.preprocessTimeStr(timeStrRaw);
        logger.info(`[定时闹钟] 时间解析: "${timeStrRaw}" -> "${timeStr}"`);
        alarmTime = moment.tz(timeStr, 'YYYY-MM-DD HH:mm', true, 'Asia/Shanghai');
    } else {
        logger.info(`[定时闹钟] 识别为相对时间: "${timeStrRaw}"`);
    }

    if (!alarmTime.isValid()) {
      e.reply('喵... 这个时间格式我还不能完全理解呢。\n请试试 "今天下午3点" 或 "10分钟后" 这样的格式哦~\n发送 #闹钟详细帮助 查看更多示例。', true);
      return true;
    }

    if (alarmTime.isBefore(moment())) {
      e.reply('不能设置一个过去的时间哦，我们没法穿越回去啦~', true);
      return true;
    }

    if (!e.context) e.context = {};
    e.context.alarmData = {
      alarmTime: alarmTime.toISOString(),
      target_id: target_id
    };

    this.setContext('setAlarmStep2', e, 120); 
    
    let promptMsg;
    if (target_id === e.user_id) {
        promptMsg = '好的，时间已收到！\n请问你要设置什么事情的闹钟提醒呢？';
    } else {
        promptMsg = ['好的，时间已收到！\n请问你要提醒 ', segment.at(target_id), ' 什么事呢？'];
    }
    await e.reply(promptMsg, true);
    return true;
  }

  /**
   * 设置闹钟 - 第二步：获取提醒内容并创建任务
   */
  async setAlarmStep2(e) {
    const { alarmTime, target_id } = e.context.alarmData;
    const content = this.e.raw_message.trim();
    
    this.finish('setAlarmStep2', e);

    if (!content) {
      e.reply('闹钟内容不能为空哦，设置失败了。', true);
      return true;
    }

    const alarmData = {
      setter_id: this.e.user_id,
      target_id: target_id,
      group_id: this.e.group_id,
      content: content,
      time: alarmTime,
      key: `${ALARM_REDIS_PREFIX}${moment(alarmTime).unix()}:${this.e.user_id}:${Math.random()}`
    };

    try {
      const expireSeconds = moment(alarmTime).diff(moment(), 'seconds') + 300;
      await redis.set(alarmData.key, JSON.stringify(alarmData), { EX: expireSeconds });
      this.scheduleAlarmJob(alarmData);

      const formattedTime = moment(alarmTime).format('YYYY年MM月DD日 HH:mm:ss');
      const replyMsg = [
        '喵~ 闹钟设置好啦！\n我会在 ',
        formattedTime,
        '\n提醒 ',
        segment.at(target_id),
        `：“${content}”`
      ];
      await e.reply(replyMsg, true);

    } catch (error) {
      logger.error('[定时闹钟] 创建闹钟任务失败:', error);
      await e.reply('抱歉，闹钟设置失败了，请稍后再试。', true);
    }
    return true;
  }

  /**
   * 核心函数：创建一个 schedule 任务
   */
  scheduleAlarmJob(alarmData) {
    schedule.scheduleJob(alarmData.key, new Date(alarmData.time), async () => {
      try {
        const group = Bot.pickGroup(alarmData.group_id);
        if (group) {
          let msg = [
            segment.at(alarmData.target_id),
            ` 叮咚！闹钟时间到啦！\n${alarmData.content}`
          ];
          await group.sendMsg(msg);
          logger.info(`[定时闹钟] 已成功触发闹钟: ${alarmData.group_id} - @${alarmData.target_id}`);
        }
      } catch (error) {
        logger.error(`[定时闹钟] 发送提醒消息失败:`, error);
      } finally {
        await redis.del(alarmData.key);
      }
    });
    logger.info(`[定时闹钟] 已成功调度一个新闹钟任务, 时间: ${alarmData.time}, 提醒对象: ${alarmData.target_id}`);
  }
}
