// 导出名称已按目标 DSH Desktop 的 platform seed 与 primitives 核对。
declare function require(name: string): unknown
const primitives = require('@deepseek-ai/dsh-client-ui-primitives') as Record<string, unknown>
export const {
  Menu, MenuGroup, MenuItemButton,
  IconChevronDownOutlineRegular, IconChevronRightOutlineRegular,
  IconPanelLeftOutlineRegular, IconSendOutlineMedium,
  MarkdownText, Toast,
} = primitives
/**
 * DSH 0.2.2 起原语改为在子菜单行自绘右箭头，并接管 ArrowRight／Tab 进入子菜单；
 * 0.2.0／0.2.1 两者都没有，需要插件自己补。菜单定位不依赖本探测：
 * 调用方会同时传 anchorPoint 与 getAnchorRect，各版本只读自己认识的那个。
 * 探测只读函数签名文本，无副作用；识别失败时退回旧版写法，
 * 最坏结果是新版多出一枚箭头，定位、选择与菜单生命周期不受影响。
 */
const menuSignature = typeof primitives.Menu === 'function' ? Function.prototype.toString.call(primitives.Menu) : ''
export const nativeSubmenuArrow = /\banchorPoint\b/u.test(menuSignature)
