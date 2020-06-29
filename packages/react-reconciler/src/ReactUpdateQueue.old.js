/**
 * Copyright (c) Facebook, Inc. and its affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 * @flow
 */

// UpdateQueue is a linked list of prioritized updates.
//
// Like fibers, update queues come in pairs: a current queue, which represents
// the visible state of the screen, and a work-in-progress queue, which can be
// mutated and processed asynchronously before it is committed — a form of
// double buffering. If a work-in-progress render is discarded before finishing,
// we create a new work-in-progress by cloning the current queue.
//
// Both queues share a persistent, singly-linked list structure. To schedule an
// update, we append it to the end of both queues. Each queue maintains a
// pointer to first update in the persistent list that hasn't been processed.
// The work-in-progress pointer always has a position equal to or greater than
// the current queue, since we always work on that one. The current queue's
// pointer is only updated during the commit phase, when we swap in the
// work-in-progress.
//
// For example:
//
//   Current pointer:           A - B - C - D - E - F
//   Work-in-progress pointer:              D - E - F
//                                          ^
//                                          The work-in-progress queue has
//                                          processed more updates than current.
//
// The reason we append to both queues is because otherwise we might drop
// updates without ever processing them. For example, if we only add updates to
// the work-in-progress queue, some updates could be lost whenever a work-in
// -progress render restarts by cloning from current. Similarly, if we only add
// updates to the current queue, the updates will be lost whenever an already
// in-progress queue commits and swaps with the current queue. However, by
// adding to both queues, we guarantee that the update will be part of the next
// work-in-progress. (And because the work-in-progress queue becomes the
// current queue once it commits, there's no danger of applying the same
// update twice.)
//
// Prioritization
// --------------
//
// Updates are not sorted by priority, but by insertion; new updates are always
// appended to the end of the list.
//
// The priority is still important, though. When processing the update queue
// during the render phase, only the updates with sufficient priority are
// included in the result. If we skip an update because it has insufficient
// priority, it remains in the queue to be processed later, during a lower
// priority render. Crucially, all updates subsequent to a skipped update also
// remain in the queue *regardless of their priority*. That means high priority
// updates are sometimes processed twice, at two separate priorities. We also
// keep track of a base state, that represents the state before the first
// update in the queue is applied.
//
// For example:
//
//   Given a base state of '', and the following queue of updates
//
//     A1 - B2 - C1 - D2
//
//   where the number indicates the priority, and the update is applied to the
//   previous state by appending a letter, React will process these updates as
//   two separate renders, one per distinct priority level:
//
//   First render, at priority 1:
//     Base state: ''
//     Updates: [A1, C1]
//     Result state: 'AC'
//
//   Second render, at priority 2:
//     Base state: 'A'            <-  The base state does not include C1,
//                                    because B2 was skipped.
//     Updates: [B2, C1, D2]      <-  C1 was rebased on top of B2
//     Result state: 'ABCD'
//
// Because we process updates in insertion order, and rebase high priority
// updates when preceding updates are skipped, the final result is deterministic
// regardless of priority. Intermediate state may vary according to system
// resources, but the final state is always the same.

import type {Fiber} from './ReactInternalTypes';
import type {Lanes, Lane} from './ReactFiberLane';
import type {SuspenseConfig} from './ReactFiberSuspenseConfig';

import {NoLane, NoLanes, isSubsetOfLanes, mergeLanes} from './ReactFiberLane';
import {
  enterDisallowedContextReadInDEV,
  exitDisallowedContextReadInDEV,
} from './ReactFiberNewContext.old';
import {Callback, ShouldCapture, DidCapture} from './ReactSideEffectTags';

import {debugRenderPhaseSideEffectsForStrictMode} from 'shared/ReactFeatureFlags';

import {StrictMode} from './ReactTypeOfMode';
import {
  markRenderEventTimeAndConfig,
  markSkippedUpdateLanes,
} from './ReactFiberWorkLoop.old';

import invariant from 'shared/invariant';

import {disableLogs, reenableLogs} from 'shared/ConsolePatchingDev';

export type Update<State> = {|
  // TODO: Temporary field. Will remove this by storing a map of
  // transition -> event time on the root.
  eventTime: number,
  lane: Lane,
  suspenseConfig: null | SuspenseConfig,

  tag: 0 | 1 | 2 | 3,
  payload: any,
  callback: (() => mixed) | null,

  next: Update<State> | null,
|};

type SharedQueue<State> = {|
  pending: Update<State> | null,
|};

export type UpdateQueue<State> = {|
  baseState: State,
  firstBaseUpdate: Update<State> | null,
  lastBaseUpdate: Update<State> | null,
  shared: SharedQueue<State>,
  effects: Array<Update<State>> | null,
|};

export const UpdateState = 0;
export const ReplaceState = 1;
export const ForceUpdate = 2;
export const CaptureUpdate = 3;

// Global state that is reset at the beginning of calling `processUpdateQueue`.
// It should only be read right after calling `processUpdateQueue`, via
// `checkHasForceUpdateAfterProcessing`.
let hasForceUpdate = false;

export let resetCurrentlyProcessingQueue;

// 初始化更新队列，接受一个fiber，无返回值
export function initializeUpdateQueue<State>(fiber: Fiber): void {
  const queue: UpdateQueue<State> = {
    baseState: fiber.memoizedState, //队列的state
    firstBaseUpdate: null, //链表的头结点
    lastBaseUpdate: null, //链表的尾节点
    shared: { //环形队列
      // next: null,
      pending: null,
    },
    effects: null,
  };
  // 给该fiber设置updateQueue属性，属性值为queue
  fiber.updateQueue = queue;
}

// 复制更新队列
export function cloneUpdateQueue<State>(
  current: Fiber,
  workInProgress: Fiber,
): void {
  // Clone the update queue from current. Unless it's already a clone.
  // 从workInProgress正在工作中的进度中拿出更新队列
  const queue = workInProgress.updateQueue;
  // 从current中拿出更新队列
  const currentQueue = current.updateQueue
  // 如果两个是同一个，从current中复制出来，更新到workInProgress上
  if (queue === currentQueue) {
    const clone  = {
      baseState: currentQueue.baseState,
      firstBaseUpdate: currentQueue.firstBaseUpdate,
      lastBaseUpdate: currentQueue.lastBaseUpdate,
      shared: currentQueue.shared,
      effects: currentQueue.effects,
    };
    workInProgress.updateQueue = clone;
  }
}

// 创建更新器，返回了一个对象
export function createUpdate(
  eventTime: number,
  lane: Lane,
  suspenseConfig: null | SuspenseConfig,
): Update<*> {
  const update: Update<*> = {
    eventTime,
    lane,
    suspenseConfig,

    tag: UpdateState,
    payload: null,
    callback: null,

    next: null,
  };
  return update;
}

// 加入到更新队列
export function enqueueUpdate<State>(fiber: Fiber, update: Update<State>) {
  // 拿到fiber的更新队列
  const updateQueue = fiber.updateQueue;
  if (updateQueue === null) {
    // Only occurs if the fiber has been unmounted.
    return;
  }
  // 从更新队列中拿出sharedQueue队列，这个队列是环形的
  const sharedQueue = updateQueue.shared;
  const pending = sharedQueue.pending;
  // 从共享数据中拿到pending，当为null代表这是第一次更新。 创建一个循环列表。
  if (pending === null) {
    // 环形队列
    update.next = update;
  } else {
    // 加入到队列头部
    update.next = pending.next;
    // 说明是个环形队列
    pending.next = update;
  }
  // 这里说明了pending应该就是这个环形队列的开始地方
  sharedQueue.pending = update;
}

// 加入捕获更新队列
export function enqueueCapturedUpdate<State>(
  workInProgress: Fiber,
  capturedUpdate: Update<State>,
) {
  //捕获的更新是child在渲染阶段抛出的更新。 如果渲染异常终止
  // ，则应将其丢弃。 因此，我们只应将它们放在正在进行的队列中，而不是当前队列中。
  // 拿到工作中的更新队列
  let queue = workInProgress.updateQueue;

  // Check if the work-in-progress queue is a clone.
  // 检查进行中的队列是否为克隆。
  // 拿出备用
  const current = workInProgress.alternate;
  // 如果备用有值
  if (current !== null) {
    const currentQueue = current.updateQueue;
    if (queue === currentQueue) {
      //进行中的队列与当前队列相同。  当我们委托在父fiber上捕捉child抛出的错误时
      // 就会发生这种情况。 由于我们只想将更新追加到正在进行的工作队列中，
      // 因此我们需要克隆更新。 我们通常在processUpdateQueue期间进行克隆，但
      // 是在这种情况下不会发生这种情况，因为在委托时我们跳过了parent。
      let newFirst = null;
      let newLast = null;
      const firstBaseUpdate = queue.firstBaseUpdate;
      if (firstBaseUpdate !== null) {
        // Loop through the updates and clone them.
        let update = firstBaseUpdate;
        do {
          const clone: Update<State> = {
            eventTime: update.eventTime,
            lane: update.lane,
            suspenseConfig: update.suspenseConfig,

            tag: update.tag,
            payload: update.payload,
            callback: update.callback,

            next: null,
          };
          if (newLast === null) {
            newFirst = newLast = clone;
          } else {
            newLast.next = clone;
            newLast = clone;
          }
          update = update.next;
        } while (update !== null);

        // Append the captured update the end of the cloned list.
        if (newLast === null) {
          newFirst = newLast = capturedUpdate;
        } else {
          newLast.next = capturedUpdate;
          newLast = capturedUpdate;
        }
      } else {
        // There are no base updates.
        newFirst = newLast = capturedUpdate;
      }
      queue = {
        baseState: currentQueue.baseState,
        firstBaseUpdate: newFirst,
        lastBaseUpdate: newLast,
        shared: currentQueue.shared,
        effects: currentQueue.effects,
      };
      workInProgress.updateQueue = queue;
      return;
    }
  }

  //将更新追加到表的末尾
  const lastBaseUpdate = queue.lastBaseUpdate;
  // 空链表
  if (lastBaseUpdate === null) {
    queue.firstBaseUpdate = capturedUpdate;
  } else {
    // 否则加到末尾的下一个
    lastBaseUpdate.next = capturedUpdate;
  }
  // 链表的最后一个是捕获到的更新
  queue.lastBaseUpdate = capturedUpdate;
}

// 获取state从更新中
function getStateFromUpdate<State>(
  workInProgress: Fiber,
  queue: UpdateQueue<State>,
  update: Update<State>,
  prevState: State,
  nextProps: any,
  instance: any,
): any {
  // 看update的tag
  /**
   * 1.直接替换型，如果有函数，执行函数
   * 2.合并型，如果有函数，执行函数
   * 3.强制更新，强制返回上一个state
   * 
   */
  switch (update.tag) {
    // 替换状态
    case ReplaceState: {
      // 从update中拿出payload，然后返回
      const payload = update.payload;
      // 如果payload是个函数,执行该函数
      if (typeof payload === 'function') {
        // Updater function
        
        const nextState = payload.call(instance, prevState, nextProps);
        
        return nextState;
      }
      // State object
      return payload;
    }
    // 捕获状态
    case CaptureUpdate: {
      workInProgress.effectTag =
        (workInProgress.effectTag & ~ShouldCapture) | DidCapture;
    }
    // 合并 this.setState({name: 123})
    case UpdateState: {
      const payload = update.payload;
      let partialState;
      // 如果是函数执行函数
      if (typeof payload === 'function') {
        // Updater function
       
        partialState = payload.call(instance, prevState, nextProps);
       
      } else {
        // Partial state object
        partialState = payload;
      }
      // 如果payload是个null或undefined,返回旧的state
      if (partialState === null || partialState === undefined) {
        // Null and undefined are treated as no-ops.
        return prevState;
      }
      // Object.assign,进行merge
      return Object.assign({}, prevState, partialState);
    }
    // 强制更新
    case ForceUpdate: {
      // 标记为强制更新,返回上一个state
      hasForceUpdate = true;
      return prevState;
    }
  }
  // 以上都不满足,返回上一个state
  return prevState;
}

// 处理更新队列
export function processUpdateQueue<State>(
  workInProgress: Fiber,
  props: any,
  instance: any,
  renderLanes: Lanes,
): void {
  // 在ClassComponent或HostRoot上始终为非null
  // 取出更新队列
  const queue = workInProgress.updateQueue

  hasForceUpdate = false;

  // 拿出头节点和尾节点
  let firstBaseUpdate = queue.firstBaseUpdate;
  let lastBaseUpdate = queue.lastBaseUpdate;

  // 检查环形队列是否为空，如果不为空，将环形队列拆开，添加到链表中
  let pendingQueue = queue.shared.pending;
  if (pendingQueue !== null) {
    // 先清空待更新队列
    queue.shared.pending = null;

    // The pending queue 是环形的. 断开指针在第一个和最后一个之间的连接，以使其非环形。
    const lastPendingUpdate = pendingQueue;
    const firstPendingUpdate = lastPendingUpdate.next;
    lastPendingUpdate.next = null;
    // 将待处理的更新附加到基本队列，将带更新队列的环拆开，加入到基本队列里
    // 如果基本队列为空
    if (lastBaseUpdate === null) {
      firstBaseUpdate = firstPendingUpdate;
    } else {
      // 否则加到后面去
      lastBaseUpdate.next = firstPendingUpdate;
    }
    lastBaseUpdate = lastPendingUpdate;

    ////如果当前队列与基本队列不同，那么我们也需要将更新转移到该队列。 
    // 因为基本队列是一个没有循环的单链接列表，所以我们可以附加到两个列表中并利用结构共享。
    // TODO: Pass `current` as argument
    // 处理备用队列
    const current = workInProgress.alternate;
    if (current !== null) {
      // This is always non-null on a ClassComponent or HostRoot
      const currentQueue: UpdateQueue<State> = (current.updateQueue: any);
      const currentLastBaseUpdate = currentQueue.lastBaseUpdate;
      if (currentLastBaseUpdate !== lastBaseUpdate) {
        if (currentLastBaseUpdate === null) {
          currentQueue.firstBaseUpdate = firstPendingUpdate;
        } else {
          currentLastBaseUpdate.next = firstPendingUpdate;
        }
        currentQueue.lastBaseUpdate = lastPendingUpdate;
      }
    }
  }

  // 链表不为空
  if (firstBaseUpdate !== null) {
    // 拿到baseState
    let newState = queue.baseState;
    // TODO: Don't need to accumulate this. Instead, we can remove renderLanes
    // from the original lanes.
    // 首先了解fiber架构，是渲染dom和js执行，将js拆分成一个个的碎片，让dom渲染优先级更高的先执行
    let newLanes = NoLanes;

    let newBaseState = null; //新链表的baseState
    let newFirstBaseUpdate = null; //新链表的头结点
    let newLastBaseUpdate = null; //新链表的尾结点
    //头节点 
    let update = firstBaseUpdate;
    // 
    do {
      const updateLane = update.lane;
      // 更新活动时间
      const updateEventTime = update.eventTime;
      // 根据优先级，构建新链表的头尾节点，对于新的baseState，优先级够，就用新的state，不够，就用旧的
      if (!isSubsetOfLanes(renderLanes, updateLane)) {
        // Priority is insufficient. Skip this update. If this is the first
        // skipped update, the previous update/state is the new base
        // update/state.
        //优先级不足。 跳过此更新。 如果这是第一个跳过的更新，则先前的更新/状态是新的基本更新/状态。

        // 如果优先级不够，先将上一个update复制下来，为下次使用
        const clone: Update<State> = {
          eventTime: updateEventTime,
          lane: updateLane,
          suspenseConfig: update.suspenseConfig,

          tag: update.tag,
          payload: update.payload,
          callback: update.callback,

          next: null,
        };
        //如果新链表还是空的 
        if (newLastBaseUpdate === null) {
          // 新链表的头结点和尾节点
          newFirstBaseUpdate = newLastBaseUpdate = clone;
          newBaseState = newState;
        } else {
          // 加到新链表的尾部
          newLastBaseUpdate = newLastBaseUpdate.next = clone;
        }
        // Update the remaining priority in the queue.
        // 更新队列中的剩余优先级。
        newLanes = mergeLanes(newLanes, updateLane);
      } else {
        //此更新确实具有足够的优先级
        //如果新链表还是空的，加入到新链表最后一个
        if (newLastBaseUpdate !== null) {
          const clone: Update<State> = {
            eventTime: updateEventTime,
            // This update is going to be committed so we never want uncommit
            // it. Using NoLane works because 0 is a subset of all bitmasks, so
            // this will never be skipped by the check above.
            lane: NoLane,
            suspenseConfig: update.suspenseConfig,

            tag: update.tag,
            payload: update.payload,
            callback: update.callback,

            next: null,
          };
          newLastBaseUpdate = newLastBaseUpdate.next = clone;
        }

        // 将此更新的事件时间标记为与此渲染过程相关
        // TODO: This should ideally use the true event time of this update rather than
        // its priority which is a derived and not reversible value.
        // TODO: We should skip this update if it was already committed but currently
        // we have no way of detecting the difference between a committed and suspended
        // update here.
        markRenderEventTimeAndConfig(updateEventTime, update.suspenseConfig);

        // Process this update.
        // 拿到新的state
        newState = getStateFromUpdate(
          workInProgress,
          queue,
          update,
          newState,
          props,
          instance,
        );
        const callback = update.callback;
        if (callback !== null) {
          workInProgress.effectTag |= Callback;
          const effects = queue.effects;
          if (effects === null) {
            queue.effects = [update];
          } else {
            effects.push(update);
          }
        }
      }
      // 拿链表的下一个
      update = update.next;
      // 如果没了
      if (update === null) {
        // 以下的过程,就是将shared环形队列拆开,然后加到链表中,然后清空环形队列,直到环形队列和链表都空了,就break掉
        pendingQueue = queue.shared.pending;
        if (pendingQueue === null) {
          break;
        } else {
          // An update was scheduled from inside a reducer. Add the new
          // pending updates to the end of the list and keep processing.
          // 定义环形队列的
          const lastPendingUpdate = pendingQueue;
          // Intentionally unsound. Pending updates form a circular list, but we
          // unravel them when transferring them to the base queue.
          // 定义环形队列的第一个，第一个是最后一个的下一个
          const firstPendingUpdate = lastPendingUpdate.next
          // 断开环形队列
          lastPendingUpdate.next = null;
          update = firstPendingUpdate;
          // 将拆开的环形队列添加到quene中
          queue.lastBaseUpdate = lastPendingUpdate;
          // 清空环形队列
          queue.shared.pending = null;
        }
      }
    } while (true);

    if (newLastBaseUpdate === null) {
      newBaseState = newState;
    }

    // 以上所有的过程,大致是这么干的
    /**
     * 将update拆了，将shard环形队列补刀链表尾部，然后对这个链表进行遍历，根据每个updated的优先级，
     * 弄出一个新的链表来，然后就是下面这段，将这个update更新为这个新的链表
     */
    queue.baseState = newBaseState;
    queue.firstBaseUpdate = newFirstBaseUpdate;
    queue.lastBaseUpdate = newLastBaseUpdate;

    // Set the remaining expiration time to be whatever is remaining in the queue.
    // This should be fine because the only two other things that contribute to
    // expiration time are props and context. We're already in the middle of the
    // begin phase by the time we start processing the queue, so we've already
    // dealt with the props. Context in components that specify
    // shouldComponentUpdate is tricky; but we'll have to account for
    // that regardless.
    // 将剩余的到期时间设置为队列中剩余的时间。 这应该没问题，因为影响到期时间的另外两件事是props和context。 
    // 在开始处理队列时，我们已经处于开始阶段的中间，因此我们已经处理了props。 
    // 指定shouldComponentUpdate的组件中的上下文很棘手。 但无论如何，我们都必须考虑这一点。
    markSkippedUpdateLanes(newLanes);
    // 设置工作进程的车道的优先级
    workInProgress.lanes = newLanes;
    // 设置工作进程中的记忆的state为新state
    workInProgress.memoizedState = newState;
  }

}

function callCallback(callback, context) {
  invariant(
    typeof callback === 'function',
    'Invalid argument passed as callback. Expected a function. Instead ' +
      'received: %s',
    callback,
  );
  callback.call(context);
}

export function resetHasForceUpdateBeforeProcessing() {
  hasForceUpdate = false;
}

export function checkHasForceUpdateAfterProcessing(): boolean {
  return hasForceUpdate;
}

export function commitUpdateQueue<State>(
  finishedWork: Fiber,
  finishedQueue: UpdateQueue<State>,
  instance: any,
): void {
  // Commit the effects
  const effects = finishedQueue.effects;
  finishedQueue.effects = null;
  if (effects !== null) {
    for (let i = 0; i < effects.length; i++) {
      const effect = effects[i];
      const callback = effect.callback;
      if (callback !== null) {
        effect.callback = null;
        callCallback(callback, instance);
      }
    }
  }
}
