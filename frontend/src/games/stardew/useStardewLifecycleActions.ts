import { useEffect, useState } from 'react'
import { ApiError, startInstance, stopInstance, restartInstance } from '../../api'
import { errorMessage } from '../../core/helpers'
import type { InstanceState } from '../../types'
import { shouldClearPendingStartupAction, type PendingStartupAction } from './lifecycle-action-state'
import type { StardewDashboardData } from './stardew-routes'
import { useStardewLifecycleState } from './useStardewLifecycleState'

function saveStartBlocker(error: unknown): 'new' | 'saves' | null {
  if (!(error instanceof ApiError)) return null
  if (error.code === 'save_required') return 'new'
  if (error.code === 'active_save_required' || error.code === 'active_save_missing') return 'saves'
  return null
}

type LifecycleActionsOptions = {
  instanceState: InstanceState | null
  dashboardData: StardewDashboardData
  isAdmin: boolean
}

export function useStardewLifecycleActions({ instanceState, dashboardData, isAdmin }: LifecycleActionsOptions) {
  const [actionBusy, setActionBusy] = useState(false)
  const [actionError, setActionError] = useState<string | null>(null)
  const [saveRequiredDetected, setSaveRequiredDetected] = useState(false)
  const [confirmAction, setConfirmAction] = useState<'stop' | 'restart' | null>(null)
  const [pendingStartupAction, setPendingStartupAction] = useState<PendingStartupAction>(null)
  const [pendingStartupSawActiveJob, setPendingStartupSawActiveJob] = useState(false)
  const [pendingStopAction, setPendingStopAction] = useState(false)

  const state = instanceState?.state ?? null

  const lifecycle = useStardewLifecycleState({
    instanceState,
    jobs: dashboardData.jobs,
    players: dashboardData.players,
    pendingStartup: Boolean(pendingStartupAction),
    pendingStop: pendingStopAction,
  })
  const { isRunning, isStarting, isStopped, hasActiveLifecycleJob, startupInProgress, waitingForStop } = lifecycle
  const restartInProgress = pendingStartupAction === 'restart'

  const noSavesDetected = Boolean(dashboardData.saves && dashboardData.saves.saves.length === 0)
  const showSaveRequiredPrompt =
    (state === 'save_required' || saveRequiredDetected || noSavesDetected) && !isRunning && !isStarting

  // An instance parked in `error` still has a fully valid backend start path:
  // the start handler re-validates installation and the active save and answers
  // with a specific conflict code when it cannot proceed. Exposing start here is
  // what makes `new_game_recovery_required` and similar states recoverable from
  // the UI at all — the documented recovery is "start again to resume the same
  // transaction", which is unreachable while every lifecycle control is hidden.
  const errorStateRecoverable = state === 'error'
  const canStart = isAdmin && (isStopped || errorStateRecoverable) && !actionBusy && !startupInProgress && !waitingForStop && !restartInProgress
  const canStop = isAdmin && isRunning && !actionBusy && !waitingForStop && !restartInProgress
  const canRestart = isAdmin && isRunning && !actionBusy && !waitingForStop && !restartInProgress

  useEffect(() => {
    if (state && state !== 'save_required') {
      setSaveRequiredDetected(false)
    }
  }, [state])

  useEffect(() => {
    if (pendingStartupAction && hasActiveLifecycleJob) {
      setPendingStartupSawActiveJob(true)
    }
  }, [hasActiveLifecycleJob, pendingStartupAction])

  useEffect(() => {
    // Clear on success or after the submitted lifecycle job reaches any terminal state.
    if (shouldClearPendingStartupAction({
      action: pendingStartupAction,
      hasActiveLifecycleJob,
      isRunning,
      sawActiveLifecycleJob: pendingStartupSawActiveJob,
    })) {
      setPendingStartupAction(null)
      setPendingStartupSawActiveJob(false)
    }
  }, [hasActiveLifecycleJob, isRunning, pendingStartupAction, pendingStartupSawActiveJob])

  useEffect(() => {
    if (state === 'stopped' || state === 'ready_to_start' || state === 'game_installed' || state === 'save_required' || state === 'error') {
      setPendingStopAction(false)
    }
  }, [state])

  async function handleStart() {
    setActionBusy(true)
    setPendingStartupAction('start')
    setPendingStartupSawActiveJob(false)
    setPendingStopAction(false)
    setActionError(null)
    try {
      await startInstance()
      dashboardData.requestInviteCodeRefresh()
      setSaveRequiredDetected(false)
      dashboardData.refreshInstanceState()
      dashboardData.refreshJobs()
    } catch (e) {
      const saveBlocker = saveStartBlocker(e)
      if (saveBlocker) {
        setSaveRequiredDetected(saveBlocker === 'new')
        setActionError(saveBlocker === 'new' ? null : errorMessage(e))
        dashboardData.refreshInstanceState()
        dashboardData.refreshSaves()
        setPendingStartupAction(null)
        setPendingStartupSawActiveJob(false)
        return
      }
      setActionError(errorMessage(e))
      setPendingStartupAction(null)
      setPendingStartupSawActiveJob(false)
    } finally {
      setActionBusy(false)
    }
  }

  async function handleStop() {
    setActionBusy(true)
    setPendingStopAction(true)
    setPendingStartupAction(null)
    setPendingStartupSawActiveJob(false)
    setActionError(null)
    dashboardData.clearInviteCode()
    try {
      await stopInstance()
      dashboardData.refreshInstanceState()
      dashboardData.refreshJobs()
    } catch (e) {
      setActionError(errorMessage(e))
      setPendingStopAction(false)
    } finally {
      setActionBusy(false)
    }
  }

  async function handleRestart(): Promise<void> {
    setActionBusy(true)
    setPendingStartupAction('restart')
    setPendingStartupSawActiveJob(false)
    setActionError(null)
    try {
      await restartInstance()
      dashboardData.requestInviteCodeRefresh()
      dashboardData.refreshInstanceState()
      dashboardData.refreshJobs()
    } catch (e) {
      setActionError(errorMessage(e))
      setPendingStartupAction(null)
      setPendingStartupSawActiveJob(false)
      throw e
    } finally {
      setActionBusy(false)
    }
  }

  function requestConfirm(action: 'stop' | 'restart') {
    setConfirmAction(action)
  }

  function cancelConfirm() {
    setConfirmAction(null)
  }

  function confirmPendingAction() {
    const action = confirmAction
    setConfirmAction(null)
    void (action === 'stop' ? handleStop() : handleRestart()).catch(() => undefined)
  }

  return {
    ...lifecycle,
    actionBusy,
    actionError,
    restartInProgress,
    saveRequiredDetected,
    showSaveRequiredPrompt,
    confirmAction,
    canStart,
    canStop,
    canRestart,
    handleStart,
    handleStop,
    handleRestart,
    requestConfirm,
    cancelConfirm,
    confirmPendingAction,
  }
}
