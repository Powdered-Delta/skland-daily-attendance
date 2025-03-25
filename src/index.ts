import process from "node:process";
import { setTimeout } from "node:timers/promises";
import { attendance, auth, getBinding, signIn } from "./api";
import { bark, messagePusher, serverChan } from "./notifications";
import { getPrivacyName } from "./utils";
import { AttendanceLogItem, AttendanceStatus } from "./types";

interface Options {
  /** server 酱推送功能的启用，false 或者 server 酱的token */
  withServerChan?: false | string;
  /** bark 推送功能的启用，false 或者 bark 的 URL */
  withBark?: false | string;
  /** 消息推送功能的启用，false 或者 message-pusher 的 WebHook URL */
  withMessagePusher?: false | string;
}

// 新增一层方法进行统一的错误处理, 使得出现签到错误也不进行中断
export async function doAttendance(accounts: string[], options: Options) {
  let errFlag = 0;
  const logMsgList: string[] = [];
  let logMsg = "";
  // 循环账号列表进行签到
  console.log("开始签到流程");
  for (const account of accounts) {
    const logList = await doAttendanceForAccount(account);
    logList.forEach((log) => {
      if (log.status !== AttendanceStatus.SUCCESS) {
        errFlag++;
        console.error(log);
        // process.exit(1);
      }
      logMsgList.push(log.message ?? "");
    });
    await setTimeout(3000 + Math.random() * 2000);
  }
  // 对 log 进行拼装
  if (accounts.length > 1 && errFlag > 0) {
    logMsg = logMsg.concat(`签到失败数量：${errFlag}\n`);
  }
  logMsg = logMsg.concat(logMsgList.join("\n\n"));

  return await sendMessage(logMsg, options);
}

/** 将生成push方法的方法拆分出来 */
const sendMessage = async (message: string, options: Options) => {
  console.log("attandance log message:\n", message);

  let hasError = false;
  if (options.withServerChan) {
    await serverChan(options.withServerChan, `【森空岛每日签到】`, message);
  }
  if (options.withBark) {
    await bark(options.withBark, `【森空岛每日签到】`, message);
  }
  if (options.withMessagePusher) {
    await messagePusher(
      options.withMessagePusher,
      `【森空岛每日签到】`,
      message
    );
    // quit with error
    if (hasError) {
      console.error("[ServerChan] Send message to ServerChan failed.");
      process.exit(1);
    }
  }
};
/**
 * 以账号为单位进行签到，并返回该账号下所有角色的 签到log
 * ?? 考虑是否要分角色进行 logItem 处理
 * @param token
 * @param options
 * @returns
 */
export async function doAttendanceForAccount(
  token: string
): Promise<AttendanceLogItem[]> {
  const { code } = await auth(token);
  const { cred, token: signToken } = await signIn(code);
  const { list } = await getBinding(cred, signToken);
  const logItemList: AttendanceLogItem[] = [];

  // 角色列表，如果长度为1则不显示第几角色
  const characterList = list.map((i) => i.bindingList).flat();
  let currentAttendance = 0;

  const maxRetries = process.env.MAX_RETRIES
    ? parseInt(process.env.MAX_RETRIES, 10)
    : 3; // 添加最大重试次数
  await Promise.all(
    characterList.map(async (character) => {
      // 每个角色生成独立的 logItem
      const logItem: AttendanceLogItem = {
        status: AttendanceStatus.FAIL,
        message: "",
      };
      console.log(`将签到第${currentAttendance + 1}个角色`);
      let retries = 0; // 初始化重试计数器
      while (retries < maxRetries) {
        try {
          const data = await attendance(cred, signToken, {
            uid: character.uid,
            gameId: character.channelMasterId,
          });
          if (data) {
            if (data.code === 0 && data.message === "OK") {
              logItem.message = logItem.message!.concat(
                `${
                  Number(character.channelMasterId) - 1 ? "B 服" : "官服"
                }角色 ${
                  character.nickName
                } 签到成功${`, 获得了${data.data.awards
                  .map((a) => `「${a.resource.name}」${a.count}个`)
                  .join(",")}`}`
              );
              currentAttendance++;

              logItem.status = AttendanceStatus.SUCCESS;

              break; // 签到成功，跳出重试循环
            } else {
              logItem.message = logItem.message?.concat(
                `${
                  Number(character.channelMasterId) - 1 ? "B 服" : "官服"
                }角色 ${character.nickName} 第 ${
                  retries + 1
                } 次签到失败, 错误消息: ${
                  data.message
                }\n\n\`\`\`json\n${JSON.stringify(data, null, 2)}\n\`\`\``
              );
              //
              retries++; // 签到失败，增加重试计数器
            }
          } else {
            logItem.message = logItem.message!.concat(
              `${Number(character.channelMasterId) - 1 ? "B 服" : "官服"}角色 ${
                character.nickName
              } 今天已经签到过了`
            );
            logItem.status = AttendanceStatus.ALREADY_SIGNED;
            break; // 已经签到过，跳出重试循环
          }
        } catch (error: any) {
          if (error.response && error.response.status === 403) {
            logItemList.push({
              status: AttendanceStatus.ALREADY_SIGNED,
              message: `${
                Number(character.channelMasterId) - 1 ? "B 服" : "官服"
              }角色 ${character.nickName} 今天已经签到过了`,
            });

            break; // 已经签到过，跳出重试循环
          } else {
            logItem.message = logItem.message!.concat(`
              ${Number(character.channelMasterId) - 1 ? "B 服" : "官服"}角色 ${
              character.nickName
            } 签到过程中出现未知错误: ${error.message}`);
            logItem.status = AttendanceStatus.UNKNOWN;
            console.error("发生未知错误。");
            retries++; // 增加重试计数器
            // 跳过当前账号，进行下一个账号的签到
            if (retries >= maxRetries) {
              // process.exit(1); // 达到最大重试次数，终止工作流
              break;
            }
          }
        }
        // 多个角色之间的延时
        await setTimeout(3000 + Math.random() * 2000);
      }
      console.log("签到结果：\n" + logItem.message);
      // push 每个角色的 logItem
      logItemList.push(logItem);
    })
  );

  return logItemList;
}
