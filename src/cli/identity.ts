import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";

export interface CliIdentity {
  isDev: boolean;
  cliName: "hapilon" | "devhapi";
  /** 默认模式使用用户熟悉的短路径，开发模式使用实际解析后的目录。 */
  homeDisplay: string;
}

const DEFAULT_HOME = resolve(join(homedir(), ".hapilon"));

function expandHome(raw: string): string {
  if (raw === "~") return homedir();
  if (raw.startsWith("~/")) return join(homedir(), raw.slice(2));
  return raw;
}

/**
 * 入口是否来自源码检出（dev 构建）而非发布安装包。
 *
 * 判据是包根下的 `src/`：发布 tarball 的 files 只含 dist/resources/scripts，
 * 不含 src（npm pack 实测）；`npm link` 判 dev 也是对的——链接的就是检出构建。
 * HAPILON_HOME 不能作此用（未设 HAPILON_HOME 的检出、自定义 home 的安装包都会错判）。
 */
export function isSourceCheckout(cliPath: string): boolean {
  return existsSync(join(dirname(cliPath), "..", "src"));
}

/** 根据 HAPILON_HOME 推导面向用户的开发别名和配置目录文案。 */
export function deriveCliIdentity(): CliIdentity {
  const configuredHome = process.env.HAPILON_HOME;
  if (!configuredHome) {
    return { isDev: false, cliName: "hapilon", homeDisplay: "~/.hapilon" };
  }

  const home = resolve(expandHome(configuredHome));
  const isDev = home !== DEFAULT_HOME;
  return {
    isDev,
    cliName: isDev ? "devhapi" : "hapilon",
    homeDisplay: isDev ? home : "~/.hapilon",
  };
}
