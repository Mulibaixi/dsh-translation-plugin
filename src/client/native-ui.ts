// 导出名称已按目标 DSH Desktop 的 platform seed 与 primitives 核对。
declare function require(name: string): unknown
export const {
  Menu, MenuGroup, MenuItemButton,
  IconChevronDownOutlineRegular, IconChevronRightOutlineRegular,
  IconPanelLeftOutlineRegular, IconSendOutlineMedium,
} = require('@deepseek-ai/dsh-client-ui-primitives') as Record<string, unknown>
