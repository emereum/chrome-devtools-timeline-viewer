'use strict';

// eslint-disable-next-line no-unused-vars
class SyncView {
  splitViewTimelineLoaded() {
    return new Promise(resolve => {
      let isLoaded = false;
      const checkLoading = setInterval(() => {
        const timelines = SyncView.timelines();
        for (const Timeline of timelines) {
          const panel = Timeline.TimelinePanel.instance();
          if (panel._state === Timeline.TimelinePanel.State.Idle) {
            isLoaded = true;
          } else {
            isLoaded = false;
            return;
          }
        }
        if (isLoaded) {
          clearInterval(checkLoading);
          resolve();
        }
      }, 500);
    });
  }

  static synchronizeRange(originalPanel, viewerInstance) {
    viewerInstance._originalPanel = originalPanel;
    const tracingModelMinimumRecordTime = originalPanel._performanceModel.tracingModel().minimumRecordTime();
    const tracingModelMaximumRecordTime = originalPanel._performanceModel.tracingModel().maximumRecordTime();
    const referenceDuration = tracingModelMaximumRecordTime - tracingModelMinimumRecordTime;

    const targetPanels = viewerInstance.targetPanels();
    for (const targetPanel of targetPanels) {
      const performanceModel = targetPanel._performanceModel;
      const tracingModel = performanceModel.tracingModel();

      // trace times are trace-specific and not 0-based
      const baseTime = tracingModel.minimumRecordTime();
      tracingModel._maximumRecordTime = Math.min(baseTime + referenceDuration, tracingModel._maximumRecordTime);

      performanceModel.setTracingModel(tracingModel);
      targetPanel._setModel(performanceModel);
    }

    const selectionPcts = {
      start: originalPanel._overviewPane._overviewGrid._window.windowLeft,
      end: originalPanel._overviewPane._overviewGrid._window.windowRight
    };
    const durationMs = viewerInstance.syncView._getSelectionDuration(selectionPcts);
    const startMs = viewerInstance.syncView._getSelectionStart(selectionPcts);
    viewerInstance._setTargetPanelsDuration(durationMs, startMs);
  }

  /**
   * monkey patched for PerfUI.OverviewGrid.Window.prototype._setWindowPosition
   * @param {?number} start
   * @param {?number} end
   * @param {?Viewer} viewerInstance
   */
  static setWindowPositionPatch(start, end, viewerInstance) {
    // proceed w/ original code for our origin frame
    this._originalPanel = Timeline.TimelinePanel.instance();
    const beforeStartPct = this._originalPanel._overviewPane._overviewGrid._window.windowLeft;
    const beforeEndPct =  this._originalPanel._overviewPane._overviewGrid._window.windowRight;

    const selectionPcts = SyncView.originalSetWindowPosition.call(this, start, end);

    const afterStartPct = this._originalPanel._overviewPane._overviewGrid._window.windowLeft;
    const afterEndPct =  this._originalPanel._overviewPane._overviewGrid._window.windowRight;

    if(!this._originalPanel.isReindexing) {
      // set target panels duration
      const pctsWithOffset = {
        start: selectionPcts.start - (this._originalPanel.startOffsetPct ?? 0),
        end: selectionPcts.end - (this._originalPanel.endOffsetPct ?? 0),
      }
      const durationMs = viewerInstance.syncView._getSelectionDuration(pctsWithOffset);
      const startMs = viewerInstance.syncView._getSelectionStart(pctsWithOffset);
      viewerInstance.syncView._setTargetPanelsDuration(durationMs, startMs);
    } else {
      this._originalPanel.startOffsetPct = this._originalPanel.startOffsetPct ?? 0;
      this._originalPanel.endOffsetPct = this._originalPanel.endOffsetPct ?? 0;
      this._originalPanel.startOffsetPct += (afterStartPct - beforeStartPct);
      this._originalPanel.endOffsetPct += (afterEndPct - beforeEndPct);
    }
  }

  _getSelectionDuration(selectionPcts) {
    const originalPanel = this.originalPanel();
    const originTraceStart = originalPanel._overviewPane._overviewCalculator.minimumBoundary();
    const originTraceLengthMs = originalPanel._overviewPane._overviewCalculator.maximumBoundary() - originTraceStart;

    // calculate the selectionStart offset of origin frame
    const originSelectionDurationMs = (selectionPcts.end - selectionPcts.start) * originTraceLengthMs;
    return originSelectionDurationMs;
  }

  _getSelectionStart(selectionPcts) {
    const originalPanel = this.originalPanel();
    const originTraceStart = originalPanel._overviewPane._overviewCalculator.minimumBoundary();
    const originTraceLengthMs = originalPanel._overviewPane._overviewCalculator.maximumBoundary() - originTraceStart;

    const originSelectionStartMs = selectionPcts.start * originTraceLengthMs;
    return originSelectionStartMs;
  }

  _setTargetPanelsDuration(durationMs, startMs) {
    // calculate what target frames should be:
    const targetPanels = this.targetPanels();
    for (const targetPanel of targetPanels) {
      const absoluteMin = targetPanel._overviewPane._overviewCalculator.minimumBoundary();
      const targetTraceLengthMs = targetPanel._overviewPane._overviewCalculator.maximumBoundary() - absoluteMin;
      let currentLeftOffsetPct = targetPanel._overviewPane._overviewGrid._window.windowLeft;

      if(startMs) {
        currentLeftOffsetPct = startMs/targetTraceLengthMs;
      }

      const windowPercentages = {
        left: currentLeftOffsetPct,
        right: currentLeftOffsetPct + (durationMs / targetTraceLengthMs)
      };

      const pctsWithOffset = {
        left: windowPercentages.left + (targetPanel.startOffsetPct ?? 0),
        right: windowPercentages.right + (targetPanel.endOffsetPct ?? 0),
      }
      // call it on the frame's PerfUI.OverviewGrid.Window
      targetPanel._overviewPane._overviewGrid._window._setWindow(pctsWithOffset.left, pctsWithOffset.right);
    }
  }

  /**
   * No significant changes from the real thing, except adding a return value
   *   https://github.com/ChromeDevTools/devtools-frontend/blob/3becf6724b90a6a4cd41b2cf10f053c7efd166fe/front_end/perf_ui/OverviewGrid.js#L357-L366
   * @param {?number} start
   * @param {?number} end
   * @param {*}
   */
  static originalSetWindowPosition(start, end) {
    const clientWidth = this._parentElement.clientWidth;
    const windowLeft = typeof start === 'number' ? start / clientWidth : this.windowLeft;
    const windowRight = typeof end === 'number' ? end / clientWidth : this.windowRight;
    this._setWindow(windowLeft, windowRight);

    return {
      start: windowLeft,
      end: windowRight
    };
  }

  static requestWindowTimesPatch(startTime, endTime, animate, viewerInstance) {
    const durationMs = endTime - startTime;
    // sync our targetPanels
    viewerInstance.syncView._setTargetPanelsDuration(durationMs);
    // original requestWindowTimes behavior
    this._flameChartDelegate.requestWindowTimes(startTime, endTime, animate);
  }

  static timelines() {
    const frames = window.parent.document.getElementsByTagName('frame');
    return Array.from(frames)
      .map(frame => frame.contentWindow['Timeline']);
  }

  static panels() {
    const timelines = SyncView.timelines();
    return timelines.map(Timeline => Timeline.TimelinePanel.instance());
  }

  originalPanel() {
    if (!this._originalPanel) {
      this._originalPanel = Timeline.TimelinePanel.instance();
    }

    return this._originalPanel;
  }

  targetPanels() {
    return SyncView.panels().filter(panel => panel !== this.originalPanel());
  }
}
