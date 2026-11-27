import React from 'react';
import { AlertTriangle, RotateCcw } from 'lucide-react';

interface State {
  hasError: boolean;
  message: string;
  details: string | null;
}

export class ErrorBoundary extends React.Component<
  { children: React.ReactNode },
  State
> {
  constructor(props: { children: React.ReactNode }) {
    super(props);
    this.state = {
      hasError: false,
      message: '',
      details: null,
    };
  }

  static getDerivedStateFromError(error: Error): State {
    let parsedMessage = error?.message || 'An unexpected application error occurred.';
    let parsedDetails: string | null = null;

    if (parsedMessage.startsWith('{') && parsedMessage.includes('"operationType"')) {
      try {
        const info = JSON.parse(parsedMessage);
        parsedMessage = `Database access error during ${info.operationType || 'operation'} on ${info.path || 'record'}.`;
        parsedDetails = info.error || null;
      } catch {
        // Keep original message
      }
    }

    return {
      hasError: true,
      message: parsedMessage,
      details: parsedDetails,
    };
  }

  componentDidCatch(error: Error, errorInfo: React.ErrorInfo): void {
    console.error('HeatGuard ErrorBoundary caught error:', error, errorInfo);
  }

  handleReset = () => {
    this.setState({ hasError: false, message: '', details: null });
  };

  render() {
    if (this.state.hasError) {
      return (
        <div className="min-h-screen flex items-center justify-center bg-stone-100 dark:bg-stone-950 p-4">
          <div className="max-w-md w-full bg-white dark:bg-stone-900 border border-rose-300 dark:border-rose-800 rounded-2xl p-6 shadow-lg space-y-4">
            <div className="flex items-center gap-3">
              <div className="h-10 w-10 rounded-xl bg-rose-100 dark:bg-rose-950/60 text-rose-600 dark:text-rose-400 flex items-center justify-center shrink-0">
                <AlertTriangle className="w-5 h-5" />
              </div>
              <div>
                <h2 className="text-base font-bold text-stone-900 dark:text-stone-100">
                  Something went wrong
                </h2>
                <p className="text-xs text-stone-500 dark:text-stone-400">
                  HeatGuard encountered a recoverable runtime issue.
                </p>
              </div>
            </div>

            <div className="rounded-xl bg-rose-50 dark:bg-rose-950/30 border border-rose-200 dark:border-rose-800/60 p-3 text-xs text-rose-900 dark:text-rose-200 space-y-1">
              <p className="font-semibold">{this.state.message}</p>
              {this.state.details && (
                <p className="text-[11px] opacity-80 break-words">{this.state.details}</p>
              )}
            </div>

            <button
              type="button"
              onClick={this.handleReset}
              className="w-full py-2.5 px-4 rounded-xl bg-stone-900 hover:bg-stone-800 dark:bg-orange-600 dark:hover:bg-orange-700 text-white text-xs font-bold flex items-center justify-center gap-2 transition cursor-pointer"
            >
              <RotateCcw className="w-4 h-4" />
              <span>Reload View</span>
            </button>
          </div>
        </div>
      );
    }

    return this.props.children;
  }
}
