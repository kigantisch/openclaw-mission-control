"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useParams, useRouter } from "next/navigation";

import { SignInButton, SignedIn, SignedOut, useAuth } from "@clerk/nextjs";
import { Pencil, X } from "lucide-react";
import ReactMarkdown from "react-markdown";

import { BoardApprovalsPanel } from "@/components/BoardApprovalsPanel";
import { DashboardSidebar } from "@/components/organisms/DashboardSidebar";
import { TaskBoard } from "@/components/organisms/TaskBoard";
import { DashboardShell } from "@/components/templates/DashboardShell";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { getApiBaseUrl } from "@/lib/api-base";
import { cn } from "@/lib/utils";

type Board = {
  id: string;
  name: string;
  slug: string;
  board_type?: string;
  objective?: string | null;
  success_metrics?: Record<string, unknown> | null;
  target_date?: string | null;
  goal_confirmed?: boolean;
};

type Task = {
  id: string;
  title: string;
  description?: string | null;
  status: string;
  priority: string;
  due_at?: string | null;
  assigned_agent_id?: string | null;
  created_at?: string | null;
  updated_at?: string | null;
};

type Agent = {
  id: string;
  name: string;
  status: string;
  board_id?: string | null;
  is_board_lead?: boolean;
  identity_profile?: {
    emoji?: string | null;
  } | null;
};

type TaskComment = {
  id: string;
  message?: string | null;
  agent_id?: string | null;
  task_id?: string | null;
  created_at: string;
};

type Approval = {
  id: string;
  action_type: string;
  payload?: Record<string, unknown> | null;
  confidence: number;
  rubric_scores?: Record<string, number> | null;
  status: string;
  created_at: string;
  resolved_at?: string | null;
};

const apiBase = getApiBaseUrl();

const priorities = [
  { value: "low", label: "Low" },
  { value: "medium", label: "Medium" },
  { value: "high", label: "High" },
];
const statusOptions = [
  { value: "inbox", label: "Inbox" },
  { value: "in_progress", label: "In progress" },
  { value: "review", label: "Review" },
  { value: "done", label: "Done" },
];

const EMOJI_GLYPHS: Record<string, string> = {
  ":gear:": "⚙️",
  ":sparkles:": "✨",
  ":rocket:": "🚀",
  ":megaphone:": "📣",
  ":chart_with_upwards_trend:": "📈",
  ":bulb:": "💡",
  ":wrench:": "🔧",
  ":shield:": "🛡️",
  ":memo:": "📝",
  ":brain:": "🧠",
};

export default function BoardDetailPage() {
  const router = useRouter();
  const params = useParams();
  const boardIdParam = params?.boardId;
  const boardId = Array.isArray(boardIdParam) ? boardIdParam[0] : boardIdParam;
  const { getToken, isSignedIn } = useAuth();

  const [board, setBoard] = useState<Board | null>(null);
  const [tasks, setTasks] = useState<Task[]>([]);
  const [agents, setAgents] = useState<Agent[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [selectedTask, setSelectedTask] = useState<Task | null>(null);
  const [comments, setComments] = useState<TaskComment[]>([]);
  const [isCommentsLoading, setIsCommentsLoading] = useState(false);
  const [commentsError, setCommentsError] = useState<string | null>(null);
  const [isDetailOpen, setIsDetailOpen] = useState(false);
  const tasksRef = useRef<Task[]>([]);
  const [isEditDialogOpen, setIsEditDialogOpen] = useState(false);
  const [isApprovalsOpen, setIsApprovalsOpen] = useState(false);

  const [approvals, setApprovals] = useState<Approval[]>([]);
  const [isApprovalsLoading, setIsApprovalsLoading] = useState(false);
  const [approvalsError, setApprovalsError] = useState<string | null>(null);
  const [approvalsUpdatingId, setApprovalsUpdatingId] = useState<string | null>(
    null,
  );

  const [isDialogOpen, setIsDialogOpen] = useState(false);
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [priority, setPriority] = useState("medium");
  const [createError, setCreateError] = useState<string | null>(null);
  const [isCreating, setIsCreating] = useState(false);

  const [editTitle, setEditTitle] = useState("");
  const [editDescription, setEditDescription] = useState("");
  const [editStatus, setEditStatus] = useState("inbox");
  const [editPriority, setEditPriority] = useState("medium");
  const [editAssigneeId, setEditAssigneeId] = useState("");
  const [isSavingTask, setIsSavingTask] = useState(false);
  const [saveTaskError, setSaveTaskError] = useState<string | null>(null);

  const titleLabel = useMemo(
    () => (board ? `${board.name} board` : "Board"),
    [board],
  );

  const latestTaskTimestamp = (items: Task[]) => {
    let latestTime = 0;
    items.forEach((task) => {
      const value = task.updated_at ?? task.created_at;
      if (!value) return;
      const time = new Date(value).getTime();
      if (!Number.isNaN(time) && time > latestTime) {
        latestTime = time;
      }
    });
    return latestTime ? new Date(latestTime).toISOString() : null;
  };

  const loadBoard = async () => {
    if (!isSignedIn || !boardId) return;
    setIsLoading(true);
    setError(null);
    try {
      const token = await getToken();
      const [boardResponse, tasksResponse, agentsResponse] = await Promise.all([
        fetch(`${apiBase}/api/v1/boards/${boardId}`, {
          headers: {
            Authorization: token ? `Bearer ${token}` : "",
          },
        }),
        fetch(`${apiBase}/api/v1/boards/${boardId}/tasks`, {
          headers: {
            Authorization: token ? `Bearer ${token}` : "",
          },
        }),
        fetch(`${apiBase}/api/v1/agents`, {
          headers: {
            Authorization: token ? `Bearer ${token}` : "",
          },
        }),
      ]);

      if (!boardResponse.ok) {
        throw new Error("Unable to load board.");
      }
      if (!tasksResponse.ok) {
        throw new Error("Unable to load tasks.");
      }
      if (!agentsResponse.ok) {
        throw new Error("Unable to load agents.");
      }

      const boardData = (await boardResponse.json()) as Board;
      const taskData = (await tasksResponse.json()) as Task[];
      const agentData = (await agentsResponse.json()) as Agent[];
      setBoard(boardData);
      setTasks(taskData);
      setAgents(agentData);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Something went wrong.");
    } finally {
      setIsLoading(false);
    }
  };

  useEffect(() => {
    loadBoard();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [boardId, isSignedIn]);

  useEffect(() => {
    tasksRef.current = tasks;
  }, [tasks]);

  const loadApprovals = useCallback(async () => {
    if (!isSignedIn || !boardId) return;
    setIsApprovalsLoading(true);
    setApprovalsError(null);
    try {
      const token = await getToken();
      const response = await fetch(
        `${apiBase}/api/v1/boards/${boardId}/approvals`,
        {
          headers: {
            Authorization: token ? `Bearer ${token}` : "",
          },
        },
      );
      if (!response.ok) {
        throw new Error("Unable to load approvals.");
      }
      const data = (await response.json()) as Approval[];
      setApprovals(data);
    } catch (err) {
      setApprovalsError(
        err instanceof Error ? err.message : "Unable to load approvals.",
      );
    } finally {
      setIsApprovalsLoading(false);
    }
  }, [boardId, getToken, isSignedIn]);

  useEffect(() => {
    loadApprovals();
    if (!isSignedIn || !boardId) return;
    const interval = setInterval(loadApprovals, 15000);
    return () => clearInterval(interval);
  }, [boardId, isSignedIn, loadApprovals]);

  useEffect(() => {
    if (!selectedTask) {
      setEditTitle("");
      setEditDescription("");
      setEditStatus("inbox");
      setEditPriority("medium");
      setEditAssigneeId("");
      setSaveTaskError(null);
      return;
    }
    setEditTitle(selectedTask.title);
    setEditDescription(selectedTask.description ?? "");
    setEditStatus(selectedTask.status);
    setEditPriority(selectedTask.priority);
    setEditAssigneeId(selectedTask.assigned_agent_id ?? "");
    setSaveTaskError(null);
  }, [selectedTask]);

  useEffect(() => {
    if (!isSignedIn || !boardId || !board) return;
    let isCancelled = false;
    const abortController = new AbortController();

    const connect = async () => {
      try {
        const token = await getToken();
        if (!token || isCancelled) return;
        const url = new URL(`${apiBase}/api/v1/boards/${boardId}/tasks/stream`);
        const since = latestTaskTimestamp(tasksRef.current);
        if (since) {
          url.searchParams.set("since", since);
        }
        const response = await fetch(url.toString(), {
          headers: {
            Authorization: `Bearer ${token}`,
          },
          signal: abortController.signal,
        });
        if (!response.ok || !response.body) {
          throw new Error("Unable to connect task stream.");
        }
        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let buffer = "";

        while (!isCancelled) {
          const { value, done } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          buffer = buffer.replace(/\r\n/g, "\n");
          let boundary = buffer.indexOf("\n\n");
          while (boundary !== -1) {
            const raw = buffer.slice(0, boundary);
            buffer = buffer.slice(boundary + 2);
            const lines = raw.split("\n");
            let eventType = "message";
            let data = "";
            for (const line of lines) {
              if (line.startsWith("event:")) {
                eventType = line.slice(6).trim();
              } else if (line.startsWith("data:")) {
                data += line.slice(5).trim();
              }
            }
            if (eventType === "task" && data) {
              try {
                const payload = JSON.parse(data) as {
                  type?: string;
                  task?: Task;
                  comment?: TaskComment;
                };
                if (payload.comment?.task_id && payload.type === "task.comment") {
                  setComments((prev) => {
                    if (selectedTask?.id !== payload.comment?.task_id) {
                      return prev;
                    }
                    const exists = prev.some((item) => item.id === payload.comment?.id);
                    if (exists) {
                      return prev;
                    }
                    return [...prev, payload.comment as TaskComment];
                  });
                } else if (payload.task) {
                  setTasks((prev) => {
                    const index = prev.findIndex((item) => item.id === payload.task?.id);
                    if (index === -1) {
                      return [payload.task as Task, ...prev];
                    }
                    const next = [...prev];
                    next[index] = { ...next[index], ...(payload.task as Task) };
                    return next;
                  });
                }
              } catch {
                // Ignore malformed payloads.
              }
            }
            boundary = buffer.indexOf("\n\n");
          }
        }
      } catch {
        if (!isCancelled) {
          setTimeout(connect, 3000);
        }
      }
    };

    connect();
    return () => {
      isCancelled = true;
      abortController.abort();
    };
  }, [board, boardId, getToken, isSignedIn, selectedTask?.id]);

  const resetForm = () => {
    setTitle("");
    setDescription("");
    setPriority("medium");
    setCreateError(null);
  };

  const handleCreateTask = async () => {
    if (!isSignedIn || !boardId) return;
    const trimmed = title.trim();
    if (!trimmed) {
      setCreateError("Add a task title to continue.");
      return;
    }
    setIsCreating(true);
    setCreateError(null);
    try {
      const token = await getToken();
      const response = await fetch(`${apiBase}/api/v1/boards/${boardId}/tasks`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: token ? `Bearer ${token}` : "",
        },
        body: JSON.stringify({
          title: trimmed,
          description: description.trim() || null,
          status: "inbox",
          priority,
        }),
      });

      if (!response.ok) {
        throw new Error("Unable to create task.");
      }

      const created = (await response.json()) as Task;
      setTasks((prev) => [created, ...prev]);
      setIsDialogOpen(false);
      resetForm();
    } catch (err) {
      setCreateError(err instanceof Error ? err.message : "Something went wrong.");
    } finally {
      setIsCreating(false);
    }
  };

  const assigneeById = useMemo(() => {
    const map = new Map<string, string>();
    agents
      .filter((agent) => !boardId || agent.board_id === boardId)
      .forEach((agent) => {
        map.set(agent.id, agent.name);
      });
    return map;
  }, [agents, boardId]);

  const displayTasks = useMemo(
    () =>
      tasks.map((task) => ({
        ...task,
        assignee: task.assigned_agent_id
          ? assigneeById.get(task.assigned_agent_id)
          : undefined,
      })),
    [tasks, assigneeById],
  );

  const boardAgents = useMemo(
    () => agents.filter((agent) => !boardId || agent.board_id === boardId),
    [agents, boardId],
  );

  const assignableAgents = useMemo(
    () => boardAgents.filter((agent) => !agent.is_board_lead),
    [boardAgents],
  );

  const hasTaskChanges = useMemo(() => {
    if (!selectedTask) return false;
    const normalizedTitle = editTitle.trim();
    const normalizedDescription = editDescription.trim();
    const currentDescription = (selectedTask.description ?? "").trim();
    const currentAssignee = selectedTask.assigned_agent_id ?? "";
    return (
      normalizedTitle !== selectedTask.title ||
      normalizedDescription !== currentDescription ||
      editStatus !== selectedTask.status ||
      editPriority !== selectedTask.priority ||
      editAssigneeId !== currentAssignee
    );
  }, [
    editAssigneeId,
    editDescription,
    editPriority,
    editStatus,
    editTitle,
    selectedTask,
  ]);

  const orderedComments = useMemo(() => {
    return [...comments].sort((a, b) => {
      const aTime = new Date(a.created_at).getTime();
      const bTime = new Date(b.created_at).getTime();
      return bTime - aTime;
    });
  }, [comments]);

  const pendingApprovals = useMemo(
    () => approvals.filter((approval) => approval.status === "pending"),
    [approvals],
  );

  const taskApprovals = useMemo(() => {
    if (!selectedTask) return [];
    const taskId = selectedTask.id;
    return approvals.filter((approval) => {
      const payload = approval.payload ?? {};
      const payloadTaskId =
        (payload as Record<string, unknown>).task_id ??
        (payload as Record<string, unknown>).taskId ??
        (payload as Record<string, unknown>).taskID;
      return payloadTaskId === taskId;
    });
  }, [approvals, selectedTask]);

  const workingAgentIds = useMemo(() => {
    const working = new Set<string>();
    tasks.forEach((task) => {
      if (task.status === "in_progress" && task.assigned_agent_id) {
        working.add(task.assigned_agent_id);
      }
    });
    return working;
  }, [tasks]);

  const sortedAgents = useMemo(() => {
    const rank = (agent: Agent) => {
      if (workingAgentIds.has(agent.id)) return 0;
      if (agent.status === "online") return 1;
      if (agent.status === "provisioning") return 2;
      return 3;
    };
    return [...boardAgents].sort((a, b) => {
      const diff = rank(a) - rank(b);
      if (diff !== 0) return diff;
      return a.name.localeCompare(b.name);
    });
  }, [boardAgents, workingAgentIds]);

  const loadComments = async (taskId: string) => {
    if (!isSignedIn || !boardId) return;
    setIsCommentsLoading(true);
    setCommentsError(null);
    try {
      const token = await getToken();
      const response = await fetch(
        `${apiBase}/api/v1/boards/${boardId}/tasks/${taskId}/comments`,
        {
          headers: { Authorization: token ? `Bearer ${token}` : "" },
        },
      );
      if (!response.ok) {
        throw new Error("Unable to load comments.");
      }
      const data = (await response.json()) as TaskComment[];
      setComments(data);
    } catch (err) {
      setCommentsError(err instanceof Error ? err.message : "Something went wrong.");
    } finally {
      setIsCommentsLoading(false);
    }
  };

  const openComments = (task: Task) => {
    setSelectedTask(task);
    setIsDetailOpen(true);
    void loadComments(task.id);
  };

  const closeComments = () => {
    setIsDetailOpen(false);
    setSelectedTask(null);
    setComments([]);
    setCommentsError(null);
    setIsEditDialogOpen(false);
  };

  const handleTaskSave = async (closeOnSuccess = false) => {
    if (!selectedTask || !isSignedIn || !boardId) return;
    const trimmedTitle = editTitle.trim();
    if (!trimmedTitle) {
      setSaveTaskError("Title is required.");
      return;
    }
    setIsSavingTask(true);
    setSaveTaskError(null);
    try {
      const token = await getToken();
      const response = await fetch(
        `${apiBase}/api/v1/boards/${boardId}/tasks/${selectedTask.id}`,
        {
          method: "PATCH",
          headers: {
            "Content-Type": "application/json",
            Authorization: token ? `Bearer ${token}` : "",
          },
          body: JSON.stringify({
            title: trimmedTitle,
            description: editDescription.trim() || null,
            status: editStatus,
            priority: editPriority,
            assigned_agent_id: editAssigneeId || null,
          }),
        },
      );
      if (!response.ok) {
        throw new Error("Unable to update task.");
      }
      const updated = (await response.json()) as Task;
      setTasks((prev) =>
        prev.map((task) => (task.id === updated.id ? updated : task)),
      );
      setSelectedTask(updated);
      if (closeOnSuccess) {
        setIsEditDialogOpen(false);
      }
    } catch (err) {
      setSaveTaskError(err instanceof Error ? err.message : "Something went wrong.");
    } finally {
      setIsSavingTask(false);
    }
  };

  const handleTaskReset = () => {
    if (!selectedTask) return;
    setEditTitle(selectedTask.title);
    setEditDescription(selectedTask.description ?? "");
    setEditStatus(selectedTask.status);
    setEditPriority(selectedTask.priority);
    setEditAssigneeId(selectedTask.assigned_agent_id ?? "");
    setSaveTaskError(null);
  };

  const agentInitials = (agent: Agent) =>
    agent.name
      .split(" ")
      .filter(Boolean)
      .slice(0, 2)
      .map((part) => part[0])
      .join("")
      .toUpperCase();

  const resolveEmoji = (value?: string | null) => {
    if (!value) return null;
    const trimmed = value.trim();
    if (!trimmed) return null;
    if (EMOJI_GLYPHS[trimmed]) return EMOJI_GLYPHS[trimmed];
    if (trimmed.startsWith(":") && trimmed.endsWith(":")) return null;
    return trimmed;
  };

  const agentAvatarLabel = (agent: Agent) => {
    if (agent.is_board_lead) return "⚙️";
    const emoji = resolveEmoji(agent.identity_profile?.emoji ?? null);
    return emoji ?? agentInitials(agent);
  };

  const agentStatusLabel = (agent: Agent) => {
    if (workingAgentIds.has(agent.id)) return "Working";
    if (agent.status === "online") return "Active";
    if (agent.status === "provisioning") return "Provisioning";
    return "Offline";
  };

  const formatCommentTimestamp = (value: string) => {
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return "—";
    return date.toLocaleString(undefined, {
      month: "short",
      day: "numeric",
      hour: "2-digit",
      minute: "2-digit",
    });
  };

  const formatApprovalTimestamp = (value?: string | null) => {
    if (!value) return "—";
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return value;
    return date.toLocaleString(undefined, {
      month: "short",
      day: "numeric",
      hour: "2-digit",
      minute: "2-digit",
    });
  };

  const handleApprovalDecision = useCallback(
    async (approvalId: string, status: "approved" | "rejected") => {
      if (!isSignedIn || !boardId) return;
      setApprovalsUpdatingId(approvalId);
      setApprovalsError(null);
      try {
        const token = await getToken();
        const response = await fetch(
          `${apiBase}/api/v1/boards/${boardId}/approvals/${approvalId}`,
          {
            method: "PATCH",
            headers: {
              "Content-Type": "application/json",
              Authorization: token ? `Bearer ${token}` : "",
            },
            body: JSON.stringify({ status }),
          },
        );
        if (!response.ok) {
          throw new Error("Unable to update approval.");
        }
        const updated = (await response.json()) as Approval;
        setApprovals((prev) =>
          prev.map((item) => (item.id === approvalId ? updated : item)),
        );
      } catch (err) {
        setApprovalsError(
          err instanceof Error ? err.message : "Unable to update approval.",
        );
      } finally {
        setApprovalsUpdatingId(null);
      }
    },
    [boardId, getToken, isSignedIn],
  );

  return (
    <DashboardShell>
      <SignedOut>
        <div className="flex h-full flex-col items-center justify-center gap-4 rounded-2xl surface-panel p-10 text-center">
          <p className="text-sm text-muted">Sign in to view boards.</p>
          <SignInButton
            mode="modal"
            forceRedirectUrl="/boards"
            signUpForceRedirectUrl="/boards"
          >
            <Button>Sign in</Button>
          </SignInButton>
        </div>
      </SignedOut>
      <SignedIn>
        <DashboardSidebar />
        <main className="flex-1 overflow-y-auto bg-gradient-to-br from-slate-50 to-slate-100">
          <div className="sticky top-0 z-30 border-b border-slate-200 bg-white shadow-sm">
            <div className="px-8 py-6">
              <div className="flex flex-wrap items-center justify-between gap-4">
                <div>
                  <div className="flex items-center gap-2 text-xs font-semibold uppercase tracking-wider text-slate-500">
                    <span>{board?.name ?? "Board"}</span>
                  </div>
                  <h1 className="mt-2 text-2xl font-semibold text-slate-900 tracking-tight">
                    {board?.name ?? "Board"}
                  </h1>
                  <p className="mt-1 text-sm text-slate-500">
                    Keep tasks moving through your workflow.
                  </p>
                </div>
                <div className="flex flex-wrap items-center gap-3">
                  <div className="flex items-center gap-1 rounded-lg bg-slate-100 p-1">
                    <button className="rounded-md bg-slate-900 px-3 py-1.5 text-sm font-medium text-white">
                      Board
                    </button>
                    <button className="rounded-md px-3 py-1.5 text-sm font-medium text-slate-600 transition-colors hover:bg-slate-200 hover:text-slate-900">
                      List
                    </button>
                    <button className="rounded-md px-3 py-1.5 text-sm font-medium text-slate-600 transition-colors hover:bg-slate-200 hover:text-slate-900">
                      Timeline
                    </button>
                  </div>
                  <Button onClick={() => setIsDialogOpen(true)}>
                    New task
                  </Button>
                  <Button
                    variant="outline"
                    onClick={() => setIsApprovalsOpen(true)}
                    className="relative"
                  >
                    Approvals
                    {pendingApprovals.length > 0 ? (
                      <span className="ml-2 inline-flex min-w-[20px] items-center justify-center rounded-full bg-slate-900 px-2 py-0.5 text-xs font-semibold text-white">
                        {pendingApprovals.length}
                      </span>
                    ) : null}
                  </Button>
                  <Button
                    variant="outline"
                    onClick={() => router.push(`/boards/${boardId}/edit`)}
                  >
                    Board settings
                  </Button>
                  <Button
                    variant="outline"
                    onClick={() => router.push("/boards")}
                  >
                    Back to boards
                  </Button>
                </div>
              </div>
            </div>
          </div>

          <div className="relative flex gap-6 p-6">
            <aside className="flex h-full w-64 flex-col rounded-xl border border-slate-200 bg-white shadow-sm">
              <div className="flex items-center justify-between border-b border-slate-200 px-4 py-3">
                <div>
                  <p className="text-xs font-semibold uppercase tracking-wider text-slate-500">
                    Agents
                  </p>
                  <p className="text-xs text-slate-400">
                    {sortedAgents.length} total
                  </p>
                </div>
                <button
                  type="button"
                  onClick={() => router.push("/agents/new")}
                  className="rounded-md border border-slate-200 px-2.5 py-1 text-xs font-semibold text-slate-600 transition hover:border-slate-300 hover:bg-slate-50"
                >
                  Add
                </button>
              </div>
              <div className="flex-1 space-y-2 overflow-y-auto p-3">
                {sortedAgents.length === 0 ? (
                  <div className="rounded-lg border border-dashed border-slate-200 p-3 text-xs text-slate-500">
                    No agents assigned yet.
                  </div>
                ) : (
                  sortedAgents.map((agent) => {
                    const isWorking = workingAgentIds.has(agent.id);
                    return (
                      <button
                        key={agent.id}
                        type="button"
                        className={cn(
                          "flex w-full items-center gap-3 rounded-lg border border-transparent px-2 py-2 text-left transition hover:border-slate-200 hover:bg-slate-50",
                        )}
                        onClick={() => router.push(`/agents/${agent.id}`)}
                      >
                        <div className="relative flex h-9 w-9 items-center justify-center rounded-full bg-slate-100 text-xs font-semibold text-slate-700">
                          {agentAvatarLabel(agent)}
                          <span
                            className={cn(
                              "absolute -right-0.5 -bottom-0.5 h-2.5 w-2.5 rounded-full border-2 border-white",
                              isWorking
                                ? "bg-emerald-500"
                                : agent.status === "online"
                                  ? "bg-green-500"
                                  : "bg-slate-300",
                            )}
                          />
                        </div>
                        <div className="min-w-0 flex-1">
                          <p className="truncate text-sm font-medium text-slate-900">
                            {agent.name}
                          </p>
                          <p className="text-[11px] text-slate-500">
                            {agentStatusLabel(agent)}
                          </p>
                        </div>
                      </button>
                    );
                  })
                )}
              </div>
            </aside>

            <div className="min-w-0 flex-1 space-y-6">
              {error && (
                <div className="rounded-lg border border-slate-200 bg-white p-3 text-sm text-slate-600 shadow-sm">
                  {error}
                </div>
              )}

              {isLoading ? (
                <div className="flex min-h-[50vh] items-center justify-center text-sm text-slate-500">
                  Loading {titleLabel}…
                </div>
              ) : (
                <TaskBoard
                  tasks={displayTasks}
                  onCreateTask={() => setIsDialogOpen(true)}
                  isCreateDisabled={isCreating}
                  onTaskSelect={openComments}
                />
              )}
            </div>
          </div>
        </main>
      </SignedIn>
      {isDetailOpen ? (
        <div className="fixed inset-0 z-40 bg-slate-900/20" onClick={closeComments} />
      ) : null}
      <aside
        className={cn(
          "fixed right-0 top-0 z-50 h-full w-[760px] max-w-[99vw] transform bg-white shadow-2xl transition-transform",
          isDetailOpen ? "translate-x-0" : "translate-x-full",
        )}
      >
          <div className="flex h-full flex-col">
            <div className="flex items-center justify-between border-b border-slate-200 px-6 py-4">
              <div>
                <p className="text-xs font-semibold uppercase tracking-wider text-slate-500">
                  Task detail
                </p>
                <p className="mt-1 text-sm font-medium text-slate-900">
                  {selectedTask?.title ?? "Task"}
                </p>
              </div>
            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={() => setIsEditDialogOpen(true)}
                className="rounded-lg border border-slate-200 p-2 text-slate-500 transition hover:bg-slate-50"
                disabled={!selectedTask}
              >
                <Pencil className="h-4 w-4" />
              </button>
              <button
                type="button"
                onClick={closeComments}
                className="rounded-lg border border-slate-200 p-2 text-slate-500 transition hover:bg-slate-50"
              >
                <X className="h-4 w-4" />
              </button>
            </div>
            </div>
          <div className="flex-1 space-y-6 overflow-y-auto px-6 py-5">
            <div className="space-y-2">
              <p className="text-xs font-semibold uppercase tracking-wider text-slate-500">
                Description
              </p>
              <p className="text-sm text-slate-700 whitespace-pre-wrap break-words">
                {selectedTask?.description || "No description provided."}
              </p>
            </div>
            <div className="space-y-3">
              <div className="flex items-center justify-between">
                <p className="text-xs font-semibold uppercase tracking-wider text-slate-500">
                  Approvals
                </p>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => setIsApprovalsOpen(true)}
                >
                  View all
                </Button>
              </div>
              {approvalsError ? (
                <div className="rounded-lg border border-slate-200 bg-slate-50 p-3 text-xs text-slate-500">
                  {approvalsError}
                </div>
              ) : isApprovalsLoading ? (
                <p className="text-sm text-slate-500">Loading approvals…</p>
              ) : taskApprovals.length === 0 ? (
                <p className="text-sm text-slate-500">
                  No approvals tied to this task.{" "}
                  {pendingApprovals.length > 0
                    ? `${pendingApprovals.length} pending on this board.`
                    : "No pending approvals on this board."}
                </p>
              ) : (
                <div className="space-y-3">
                  {taskApprovals.map((approval) => (
                    <div
                      key={approval.id}
                      className="rounded-xl border border-slate-200 bg-white p-3"
                    >
                      <div className="flex flex-wrap items-start justify-between gap-2 text-xs text-slate-500">
                        <div>
                          <p className="text-xs font-semibold uppercase tracking-wider text-slate-500">
                            {approval.action_type.replace(/_/g, " ")}
                          </p>
                          <p className="mt-1 text-xs text-slate-500">
                            Requested {formatApprovalTimestamp(approval.created_at)}
                          </p>
                        </div>
                        <span className="text-xs font-semibold text-slate-700">
                          {approval.confidence}% confidence · {approval.status}
                        </span>
                      </div>
                      {approval.payload ? (
                        <pre className="mt-2 whitespace-pre-wrap text-xs text-slate-600">
                          {JSON.stringify(approval.payload, null, 2)}
                        </pre>
                      ) : null}
                      {approval.status === "pending" ? (
                        <div className="mt-3 flex flex-wrap gap-2">
                          <Button
                            size="sm"
                            onClick={() =>
                              handleApprovalDecision(approval.id, "approved")
                            }
                            disabled={approvalsUpdatingId === approval.id}
                          >
                            Approve
                          </Button>
                          <Button
                            variant="outline"
                            size="sm"
                            onClick={() =>
                              handleApprovalDecision(approval.id, "rejected")
                            }
                            disabled={approvalsUpdatingId === approval.id}
                            className="border-slate-300 text-slate-700"
                          >
                            Reject
                          </Button>
                        </div>
                      ) : null}
                    </div>
                  ))}
                </div>
              )}
            </div>
            <div className="space-y-3">
              <p className="text-xs font-semibold uppercase tracking-wider text-slate-500">
                Comments
              </p>
              {isCommentsLoading ? (
                <p className="text-sm text-slate-500">Loading comments…</p>
              ) : commentsError ? (
                <div className="rounded-lg border border-slate-200 bg-slate-50 p-3 text-xs text-slate-500">
                  {commentsError}
                </div>
              ) : comments.length === 0 ? (
                <p className="text-sm text-slate-500">No comments yet.</p>
              ) : (
                <div className="space-y-3">
                  {orderedComments.map((comment) => (
                    <div
                      key={comment.id}
                      className="rounded-xl border border-slate-200 bg-white p-3"
                    >
                      <>
                      <div className="flex items-center justify-between text-xs text-slate-500">
                        <span>
                          {comment.agent_id
                            ? assigneeById.get(comment.agent_id) ?? "Agent"
                            : "Admin"}
                        </span>
                        <span>{formatCommentTimestamp(comment.created_at)}</span>
                      </div>
                      {comment.message?.trim() ? (
                        <div className="mt-2 text-sm text-slate-900 whitespace-pre-wrap break-words">
                          <ReactMarkdown
                            components={{
                              p: ({ ...props }) => (
                                <p
                                  className="text-sm text-slate-900 whitespace-pre-wrap break-words"
                                  {...props}
                                />
                              ),
                              ul: ({ ...props }) => (
                                <ul
                                  className="list-disc pl-5 text-sm text-slate-900 whitespace-pre-wrap break-words"
                                  {...props}
                                />
                              ),
                              li: ({ ...props }) => (
                                <li
                                  className="mb-1 text-sm text-slate-900 whitespace-pre-wrap break-words"
                                  {...props}
                                />
                              ),
                              strong: ({ ...props }) => (
                                <strong
                                  className="font-semibold text-slate-900"
                                  {...props}
                                />
                              ),
                            }}
                          >
                            {comment.message}
                          </ReactMarkdown>
                        </div>
                      ) : (
                        <p className="mt-2 text-sm text-slate-900">—</p>
                      )}
                      </>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>
        </div>
      </aside>

      <Dialog open={isApprovalsOpen} onOpenChange={setIsApprovalsOpen}>
        <DialogContent aria-label="Approvals">
          <DialogHeader>
            <DialogTitle>Approvals</DialogTitle>
            <DialogDescription>
              Review pending decisions from your lead agent.
            </DialogDescription>
          </DialogHeader>
          {boardId ? <BoardApprovalsPanel boardId={boardId} /> : null}
        </DialogContent>
      </Dialog>

      <Dialog open={isEditDialogOpen} onOpenChange={setIsEditDialogOpen}>
        <DialogContent aria-label="Edit task">
          <DialogHeader>
            <DialogTitle>Edit task</DialogTitle>
            <DialogDescription>
              Update task details, priority, status, or assignment.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4">
            <div className="space-y-2">
              <label className="text-xs font-semibold uppercase tracking-wider text-slate-500">
                Title
              </label>
              <Input
                value={editTitle}
                onChange={(event) => setEditTitle(event.target.value)}
                placeholder="Task title"
                disabled={!selectedTask || isSavingTask}
              />
            </div>
            <div className="space-y-2">
              <label className="text-xs font-semibold uppercase tracking-wider text-slate-500">
                Description
              </label>
              <Textarea
                value={editDescription}
                onChange={(event) => setEditDescription(event.target.value)}
                placeholder="Task details"
                className="min-h-[140px]"
                disabled={!selectedTask || isSavingTask}
              />
            </div>
            <div className="grid gap-4 md:grid-cols-2">
              <div className="space-y-2">
                <label className="text-xs font-semibold uppercase tracking-wider text-slate-500">
                  Status
                </label>
                <Select
                  value={editStatus}
                  onValueChange={setEditStatus}
                  disabled={!selectedTask || isSavingTask}
                >
                  <SelectTrigger>
                    <SelectValue placeholder="Select status" />
                  </SelectTrigger>
                  <SelectContent>
                    {statusOptions.map((option) => (
                      <SelectItem key={option.value} value={option.value}>
                        {option.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-2">
                <label className="text-xs font-semibold uppercase tracking-wider text-slate-500">
                  Priority
                </label>
                <Select
                  value={editPriority}
                  onValueChange={setEditPriority}
                  disabled={!selectedTask || isSavingTask}
                >
                  <SelectTrigger>
                    <SelectValue placeholder="Select priority" />
                  </SelectTrigger>
                  <SelectContent>
                    {priorities.map((option) => (
                      <SelectItem key={option.value} value={option.value}>
                        {option.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            </div>
            <div className="space-y-2">
              <label className="text-xs font-semibold uppercase tracking-wider text-slate-500">
                Assignee
              </label>
              <Select
                value={editAssigneeId || "unassigned"}
                onValueChange={(value) =>
                  setEditAssigneeId(value === "unassigned" ? "" : value)
                }
                disabled={!selectedTask || isSavingTask}
              >
                <SelectTrigger>
                  <SelectValue placeholder="Unassigned" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="unassigned">Unassigned</SelectItem>
                  {assignableAgents.map((agent) => (
                    <SelectItem key={agent.id} value={agent.id}>
                      {agent.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              {assignableAgents.length === 0 ? (
                <p className="text-xs text-slate-500">
                  Add agents to assign tasks.
                </p>
              ) : null}
            </div>
            {saveTaskError ? (
              <div className="rounded-lg border border-slate-200 bg-white p-3 text-xs text-slate-600">
                {saveTaskError}
              </div>
            ) : null}
          </div>
          <DialogFooter className="flex flex-wrap gap-2">
            <Button
              variant="outline"
              onClick={handleTaskReset}
              disabled={!selectedTask || isSavingTask || !hasTaskChanges}
            >
              Reset
            </Button>
            <Button
              onClick={() => handleTaskSave(true)}
              disabled={!selectedTask || isSavingTask || !hasTaskChanges}
            >
              {isSavingTask ? "Saving…" : "Save changes"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog
        open={isDialogOpen}
        onOpenChange={(nextOpen) => {
          setIsDialogOpen(nextOpen);
          if (!nextOpen) {
            resetForm();
          }
        }}
      >
        <DialogContent aria-label={titleLabel}>
          <DialogHeader>
            <DialogTitle>New task</DialogTitle>
            <DialogDescription>
              Add a task to the inbox and triage it when you are ready.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4">
            <div className="space-y-2">
              <label className="text-sm font-medium text-strong">Title</label>
              <Input
                value={title}
                onChange={(event) => setTitle(event.target.value)}
                placeholder="e.g. Prepare launch notes"
              />
            </div>
            <div className="space-y-2">
              <label className="text-sm font-medium text-strong">
                Description
              </label>
              <Textarea
                value={description}
                onChange={(event) => setDescription(event.target.value)}
                placeholder="Optional details"
                className="min-h-[120px]"
              />
            </div>
            <div className="space-y-2">
              <label className="text-sm font-medium text-strong">
                Priority
              </label>
              <Select value={priority} onValueChange={setPriority}>
                <SelectTrigger>
                  <SelectValue placeholder="Select priority" />
                </SelectTrigger>
                <SelectContent>
                  {priorities.map((item) => (
                    <SelectItem key={item.value} value={item.value}>
                      {item.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            {createError ? (
              <div className="rounded-lg border border-[color:var(--border)] bg-[color:var(--surface-muted)] p-3 text-xs text-muted">
                {createError}
              </div>
            ) : null}
          </div>
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => setIsDialogOpen(false)}
            >
              Cancel
            </Button>
            <Button
              onClick={handleCreateTask}
              disabled={isCreating}
            >
              {isCreating ? "Creating…" : "Create task"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* onboarding moved to board settings */}
    </DashboardShell>
  );
}
