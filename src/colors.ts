import chalk from "chalk";

export const C = {
  GREEN: chalk.hex("#00ff41"),
  YELLOW: chalk.yellow,
  RED: chalk.red,
  CYAN: chalk.cyan,
  GRAY: chalk.gray,
  BOLD: chalk.bold
};

export function ok(msg: string): void {
  console.log(C.GREEN(`  ✅ ${msg}`));
}

export function warn(msg: string): void {
  console.log(C.YELLOW(`  ⚠️  ${msg}`));
}

export function info(msg: string): void {
  console.log(C.CYAN(`  ${msg}`));
}

export function skip(msg: string): void {
  console.log(C.GRAY(`  ⏸️  ${msg}`));
}

