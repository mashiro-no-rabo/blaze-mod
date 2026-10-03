export type BlazeArtifact = {
  type: string
  name: string
  path: string
  title: string
  status: string | null
}

export type BlazeChange = {
  changeId: string
  shortId: string
  isWorkingCopy: boolean
  description: string
  artifacts: BlazeArtifact[]
}

export type BlazeView = {
  root: string | null
  changes: BlazeChange[]
  error: string | null
}

export type BlazeTab = 'plan' | 'tickets' | 'diff'

export type BlazeDoc = {
  path: string
  text: string
}

declare module 'claude-code' {
  interface PluginState {
    blaze: {
      view: BlazeView
      selectedChange: string | null
      tab: BlazeTab
      selectedArtifact: string | null
      doc: BlazeDoc | null
    }
  }
}
