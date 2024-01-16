import { Build, writeTask } from '@stencil/core';
import { printIonWarning } from '@utils/logging';

import {
  LIFECYCLE_DID_ENTER,
  LIFECYCLE_DID_LEAVE,
  LIFECYCLE_WILL_ENTER,
  LIFECYCLE_WILL_LEAVE,
} from '../../components/nav/constants';
import type { NavOptions, NavDirection } from '../../components/nav/nav-interface';
import { config } from '../../global/config';
import type { Animation, AnimationBuilder } from '../animation/animation-interface';
import { raf } from '../helpers';

const iosTransitionAnimation = () => import('./ios.transition');
const mdTransitionAnimation = () => import('./md.transition');
// TODO(FW-2832): types

export const transition = (opts: TransitionOptions): Promise<TransitionResult> => {
  return new Promise((resolve, reject) => {
    writeTask(() => {
      beforeTransition(opts);
      runTransition(opts).then(
        (result) => {
          if (result.animation) {
            result.animation.destroy();
          }
          afterTransition(opts);
          resolve(result);
        },
        (error) => {
          afterTransition(opts);
          reject(error);
        }
      );
    });
  });
};

const LAST_FOCUS = 'ion-last-focus';
const beforeTransition = (opts: TransitionOptions) => {
  const enteringEl = opts.enteringEl;
  const leavingEl = opts.leavingEl;
  const focusManagerEnabled = config.get('experimentalFocusManagerPriority', false);

  /**
   * When going back to a previously visited page
   * focus should typically be moved back to the
   * element that was last focused when the user
   * was on this view.
   */
  if (focusManagerEnabled) {
    const activeEl = document.activeElement;
    if (activeEl !== null && leavingEl?.contains(activeEl)) {
      activeEl.setAttribute(LAST_FOCUS, 'true');
    }
  }

  setZIndex(enteringEl, leavingEl, opts.direction);

  if (opts.showGoBack) {
    enteringEl.classList.add('can-go-back');
  } else {
    enteringEl.classList.remove('can-go-back');
  }
  setPageHidden(enteringEl, false);

  /**
   * When transitioning, the page should not
   * respond to click events. This resolves small
   * issues like users double tapping the ion-back-button.
   * These pointer events are removed in `afterTransition`.
   */
  enteringEl.style.setProperty('pointer-events', 'none');

  if (leavingEl) {
    setPageHidden(leavingEl, false);
    leavingEl.style.setProperty('pointer-events', 'none');
  }
};

const runTransition = async (opts: TransitionOptions): Promise<TransitionResult> => {
  const animationBuilder = await getAnimationBuilder(opts);

  const ani = animationBuilder && Build.isBrowser ? animation(animationBuilder, opts) : noAnimation(opts); // fast path for no animation

  return ani;
};

/**
 * Moves focus to a specified element.
 * Note that we do not remove the tabindex
 * because that can result in an unintentional
 * blur. Non-focusables can't be focused, so the
 * body will get focused again.
 */
const moveFocus = (el: HTMLElement) => {
  el.tabIndex = -1;
  el.focus();
  console.log('focus',el)
};

/**
 * Elements that are hidden using `display: none` should
 * not be focused even if they are present in the DOM.
 */
const isVisible = (el: HTMLElement) => {
  return el.offsetParent !== null;
}

const afterTransition = (opts: TransitionOptions) => {
  const enteringEl = opts.enteringEl;
  const leavingEl = opts.leavingEl;
  enteringEl.classList.remove('ion-page-invisible');
  enteringEl.style.removeProperty('pointer-events');
  if (leavingEl !== undefined) {
    leavingEl.classList.remove('ion-page-invisible');
    leavingEl.style.removeProperty('pointer-events');
  }

  const focusManagerPriorities = config.get('experimentalFocusManagerPriority', false);
  if (Array.isArray(focusManagerPriorities) && !enteringEl.contains(document.activeElement)) {
    /**
     * When going back to a previously visited view
     * focus should always be moved back to the element
     * that the user was last focused on when they were on this view.
     */
    const lastFocus = enteringEl.querySelector<HTMLElement>(`[${LAST_FOCUS}]`);
    if (lastFocus && isVisible(lastFocus)) {
      moveFocus(lastFocus);
      return;
    }

    for (const priority of focusManagerPriorities) {
      switch (priority) {
        case 'content':
          /**
           * If no level one heading exists then we should at least focus the
           * header so focus starts at the top of the page.
           */
          const content = enteringEl.querySelector<HTMLElement>('main, [role="main"]');
          if (content && isVisible(content)) {
            moveFocus(content);
            return;
          }
          break;
        case 'heading':
          /**
           * If no last focus exists then we should prefer to focus
           * level one headings. We do not prioritize the header yet
           * because the header can have non-title elements such as
           * a back button which is not necessarily helpful
           * to focus first.
           */
          const headingOne = enteringEl.querySelector<HTMLElement>('h1, [role="heading"][aria-level="1"]');
          if (headingOne && isVisible(headingOne)) {
            moveFocus(headingOne);
            return;
          }
          break;
        case 'banner':
          /**
           * If no level one heading exists then we should at least focus the
           * header so focus starts at the top of the page.
           */
          const header = enteringEl.querySelector<HTMLElement>('header, [role="banner"]');
          if (header && isVisible(header)) {
            moveFocus(header);
            return;
          }
          break;
        default:
          printIonWarning(`Unrecognized focus manager priority value ${priority}`);
          break;
      }
    }

    /**
     * If there is no header then focus the page
     * so focus at least moves to the correct view.
     * The browser will then determine where within the
     * page to move focus to.
     */
    moveFocus(enteringEl);
  }
};

const getAnimationBuilder = async (opts: TransitionOptions): Promise<AnimationBuilder | undefined> => {
  if (!opts.leavingEl || !opts.animated || opts.duration === 0) {
    return undefined;
  }

  if (opts.animationBuilder) {
    return opts.animationBuilder;
  }

  const getAnimation =
    opts.mode === 'ios'
      ? (await iosTransitionAnimation()).iosTransitionAnimation
      : (await mdTransitionAnimation()).mdTransitionAnimation;

  return getAnimation;
};

const animation = async (animationBuilder: AnimationBuilder, opts: TransitionOptions): Promise<TransitionResult> => {
  await waitForReady(opts, true);

  const trans = animationBuilder(opts.baseEl, opts);

  fireWillEvents(opts.enteringEl, opts.leavingEl);

  const didComplete = await playTransition(trans, opts);

  if (opts.progressCallback) {
    opts.progressCallback(undefined);
  }

  if (didComplete) {
    fireDidEvents(opts.enteringEl, opts.leavingEl);
  }

  return {
    hasCompleted: didComplete,
    animation: trans,
  };
};

const noAnimation = async (opts: TransitionOptions): Promise<TransitionResult> => {
  const enteringEl = opts.enteringEl;
  const leavingEl = opts.leavingEl;
  const focusManagerEnabled = config.get('experimentalFocusManagerPriority', false);

  /**
   * If the focus manager is enabled then we
   * need to wait for Ionic components to be rendered
   * otherwise the correct component to focus may not
   * be focused because it is still hidden.
   * However, if the manager is not enabled
   * then there's no need to wait since there will be no animation.
   */
  await waitForReady(opts, focusManagerEnabled);

  fireWillEvents(enteringEl, leavingEl);
  fireDidEvents(enteringEl, leavingEl);

  return {
    hasCompleted: true,
  };
};

const waitForReady = async (opts: TransitionOptions, defaultDeep: boolean) => {
  const deep = opts.deepWait !== undefined ? opts.deepWait : defaultDeep;

  if (deep) {
    await Promise.all([deepReady(opts.enteringEl), deepReady(opts.leavingEl)]);
  }

  await notifyViewReady(opts.viewIsReady, opts.enteringEl);
};

const notifyViewReady = async (
  viewIsReady: undefined | ((enteringEl: HTMLElement) => Promise<any>),
  enteringEl: HTMLElement
) => {
  if (viewIsReady) {
    await viewIsReady(enteringEl);
  }
};

const playTransition = (trans: Animation, opts: TransitionOptions): Promise<boolean> => {
  const progressCallback = opts.progressCallback;

  const promise = new Promise<boolean>((resolve) => {
    trans.onFinish((currentStep: any) => resolve(currentStep === 1));
  });

  // cool, let's do this, start the transition
  if (progressCallback) {
    // this is a swipe to go back, just get the transition progress ready
    // kick off the swipe animation start
    trans.progressStart(true);
    progressCallback(trans);
  } else {
    // only the top level transition should actually start "play"
    // kick it off and let it play through
    // ******** DOM WRITE ****************
    trans.play();
  }
  // create a callback for when the animation is done
  return promise;
};

const fireWillEvents = (enteringEl: HTMLElement | undefined, leavingEl: HTMLElement | undefined) => {
  lifecycle(leavingEl, LIFECYCLE_WILL_LEAVE);
  lifecycle(enteringEl, LIFECYCLE_WILL_ENTER);
};

const fireDidEvents = (enteringEl: HTMLElement | undefined, leavingEl: HTMLElement | undefined) => {
  lifecycle(enteringEl, LIFECYCLE_DID_ENTER);
  lifecycle(leavingEl, LIFECYCLE_DID_LEAVE);
};

export const lifecycle = (el: HTMLElement | undefined, eventName: string) => {
  if (el) {
    const ev = new CustomEvent(eventName, {
      bubbles: false,
      cancelable: false,
    });
    el.dispatchEvent(ev);
  }
};

/**
 * Wait two request animation frame loops.
 * This allows the framework implementations enough time to mount
 * the user-defined contents. This is often needed when using inline
 * modals and popovers that accept user components. For popover,
 * the contents must be mounted for the popover to be sized correctly.
 * For modals, the contents must be mounted for iOS to run the
 * transition correctly.
 *
 * On Angular and React, a single raf is enough time, but for Vue
 * we need to wait two rafs. As a result we are using two rafs for
 * all frameworks to ensure contents are mounted.
 */
export const waitForMount = (): Promise<void> => {
  return new Promise((resolve) => raf(() => raf(() => resolve())));
};

export const deepReady = async (el: any | undefined): Promise<void> => {
  const element = el as any;
  if (element) {
    if (element.componentOnReady != null) {
      // eslint-disable-next-line custom-rules/no-component-on-ready-method
      const stencilEl = await element.componentOnReady();
      if (stencilEl != null) {
        return;
      }

      /**
       * Custom elements in Stencil will have __registerHost.
       */
    } else if (element.__registerHost != null) {
      /**
       * Non-lazy loaded custom elements need to wait
       * one frame for component to be loaded.
       */
      const waitForCustomElement = new Promise((resolve) => raf(resolve));
      await waitForCustomElement;

      return;
    }
    await Promise.all(Array.from(element.children).map(deepReady));
  }
};

export const setPageHidden = (el: HTMLElement, hidden: boolean) => {
  if (hidden) {
    el.setAttribute('aria-hidden', 'true');
    el.classList.add('ion-page-hidden');
  } else {
    el.hidden = false;
    el.removeAttribute('aria-hidden');
    el.classList.remove('ion-page-hidden');
  }
};

const setZIndex = (
  enteringEl: HTMLElement | undefined,
  leavingEl: HTMLElement | undefined,
  direction: NavDirection | undefined
) => {
  if (enteringEl !== undefined) {
    enteringEl.style.zIndex = direction === 'back' ? '99' : '101';
  }
  if (leavingEl !== undefined) {
    leavingEl.style.zIndex = '100';
  }
};

export const getIonPageElement = (element: HTMLElement) => {
  if (element.classList.contains('ion-page')) {
    return element;
  }

  const ionPage = element.querySelector(':scope > .ion-page, :scope > ion-nav, :scope > ion-tabs');
  if (ionPage) {
    return ionPage;
  }
  // idk, return the original element so at least something animates and we don't have a null pointer
  return element;
};

export interface TransitionOptions extends NavOptions {
  progressCallback?: (ani: Animation | undefined) => void;
  baseEl: any;
  enteringEl: HTMLElement;
  leavingEl: HTMLElement | undefined;
}

export interface TransitionResult {
  hasCompleted: boolean;
  animation?: Animation;
}
