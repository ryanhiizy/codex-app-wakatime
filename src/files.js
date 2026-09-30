const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
function basenameAny(value) {
  return String(value || "")
    .split(/[\\/]/)
    .filter(Boolean)
    .pop() || "project";
}

function getParentDir(currentPath) {
  const parsed = path.parse(currentPath);

  if (currentPath === parsed.root) {
    return null;
  }

  return path.dirname(currentPath);
}

function hasGitMarker(dirPath) {
  return fs.existsSync(path.join(dirPath, ".git"));
}

function resolveProjectRootRaw(startPath) {
  if (!startPath) {
    return process.cwd();
  }

  let currentPath = path.resolve(startPath);
  let fallback = currentPath;

  if (!fs.existsSync(currentPath)) {
    currentPath = path.dirname(currentPath);
  } else if (!fs.statSync(currentPath).isDirectory()) {
    currentPath = path.dirname(currentPath);
    fallback = currentPath;
  }

  while (currentPath) {
    if (hasGitMarker(currentPath)) {
      return currentPath;
    }

    currentPath = getParentDir(currentPath);
  }

  return fallback;
}

function getPrimaryWorktreeRoot(projectRoot) {
  // Only linked worktrees have a .git file. Ordinary projects need no git process.
  try {
    if (!fs.statSync(path.join(projectRoot, ".git")).isFile()) return projectRoot;
  } catch (error) {
    if (error.code === "ENOENT" || error.code === "ENOTDIR") return projectRoot;
    throw error;
  }
  const result = spawnSync("git", ["-C", projectRoot, "worktree", "list", "--porcelain"], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
    windowsHide: true,
    timeout: 3000,
  });

  if (result.status !== 0 || !result.stdout) {
    return projectRoot;
  }

  const firstWorktree = result.stdout.split(/\r?\n/).find((line) => line.startsWith("worktree "));
  const primaryRoot = firstWorktree ? firstWorktree.slice("worktree ".length).trim() : "";

  if (!primaryRoot || !fs.existsSync(primaryRoot)) {
    return projectRoot;
  }

  return path.resolve(primaryRoot);
}

function canonicalizeGitWorktreePath(filePath, projectRoot, primaryRoot = getPrimaryWorktreeRoot(projectRoot)) {
  const resolvedPath = path.resolve(filePath);

  if (primaryRoot === projectRoot || !resolvedPath.startsWith(`${projectRoot}${path.sep}`)) {
    return resolvedPath;
  }

  return path.join(primaryRoot, path.relative(projectRoot, resolvedPath));
}

function resolveProjectRoot(startPath) {
  const rawProjectRoot = resolveProjectRootRaw(startPath);
  return getPrimaryWorktreeRoot(rawProjectRoot);
}

function isWindowsAbsolutePath(filePath) {
  return typeof filePath === "string" && /^(?:[A-Za-z]:[\\/]|\\\\[^\\]+\\[^\\]+)/.test(filePath);
}

function isValidFilePath(value) {
  // Hook fields and patch headers already contain exact filenames, not prose.
  return typeof value === "string" && value.trim().length > 0
    && !value.includes("\0") && !/^[a-z][a-z\d+.-]*:\/\//i.test(value);
}

function normalizePath(filePath, cwd) {
  if (isWindowsAbsolutePath(filePath) && process.platform !== "win32") {
    const drive = filePath.match(/^([A-Za-z]):[\\/](.*)$/s);
    if (drive) return `/mnt/${drive[1].toLowerCase()}/${drive[2].replace(/\\/g, "/")}`;
  }
  return path.resolve(cwd, filePath);
}

function isInsideDir(filePath, dirPath) {
  const relativePath = path.relative(dirPath, filePath);
  return relativePath === "" || (relativePath !== ".." && !relativePath.startsWith(`..${path.sep}`) && !path.isAbsolute(relativePath));
}

function filterTrackableFiles(files, cwd, logger = () => {}, projectRoot = resolveProjectRoot(cwd), rawProjectRoot = projectRoot) {
  return files.flatMap((file) => {
    if (!file || !isValidFilePath(file.path) || !isInsideDir(file.path, rawProjectRoot)) return [];
    try {
      if (!fs.statSync(file.path).isFile()) return [];
    } catch (error) {
      logger(`skipped unavailable file path=${file.path} reason=${error.code}`);
      return [];
    }
    const canonical = canonicalizeGitWorktreePath(file.path, rawProjectRoot, projectRoot);
    return [{ ...file, path: canonical,
      ...(canonical !== file.path && !fs.existsSync(canonical) ? { localFile: file.path } : {}),
    }];
  });
}

function extractEditedFilesFromPatch(patchText, cwd) {
  if (!patchText || typeof patchText !== "string") {
    return [];
  }

  const fileMap = new Map();
  const fileHeaderPattern = /^\*\*\* (?:Add File|Update File|Delete File|Move to): (.+)$/gm;

  for (const match of patchText.matchAll(fileHeaderPattern)) {
    const filePath = match[1].replace(/\r$/, "");

    if (filePath && isValidFilePath(filePath)) {
      fileMap.set(normalizePath(filePath, cwd), true);
    }
  }

  return Array.from(fileMap.keys()).map((filePath) => ({
    path: filePath,
    isWrite: true,
  }));
}

function getToolInputText(toolInput) {
  if (typeof toolInput === "string") {
    return toolInput;
  }

  if (!toolInput || typeof toolInput !== "object") {
    return "";
  }

  return [
    toolInput.command,
    toolInput.patch,
    toolInput.input,
  ].find((value) => typeof value === "string") || "";
}

function extractEditedFilesFromHookPayload(payload, cwd) {
  if (payload?.hook_event_name === "afterFileEdit") {
    return typeof payload.file_path === "string" && isValidFilePath(payload.file_path)
      ? [{ path: normalizePath(payload.file_path, cwd), isWrite: true }]
      : [];
  }

  if (!payload || payload.hook_event_name !== "PostToolUse") {
    return [];
  }

  const toolName = String(payload.tool_name || "");

  if (!/(?:^|_)apply_patch$|^Edit$|^Write$/i.test(toolName)) {
    return [];
  }

  const filePath = payload.tool_input?.file_path || payload.tool_input?.path;
  if (/^Edit$|^Write$/i.test(toolName) && typeof filePath === "string" && isValidFilePath(filePath)) {
    return [{ path: normalizePath(filePath, cwd), isWrite: true }];
  }

  return extractEditedFilesFromPatch(getToolInputText(payload.tool_input), cwd);
}

function getTurnStateKey(payload) {
  const sessionId = payload?.conversation_id || payload?.session_id;
  const turnId = payload?.generation_id || payload?.turn_id;
  if (typeof sessionId !== "string" || !sessionId || typeof turnId !== "string" || !turnId) {
    return null;
  }

  return `${sessionId}:${turnId}`;
}

function mergeFiles(existingFiles, newFiles) {
  const fileMap = new Map();

  for (const file of [...existingFiles, ...newFiles]) {
    if (file && isValidFilePath(file.path)) {
      fileMap.set(file.path, {
        path: file.path,
        isWrite: Boolean(file.isWrite || fileMap.get(file.path)?.isWrite),
      });
    }
  }

  return Array.from(fileMap.values());
}

module.exports = { basenameAny, getParentDir, hasGitMarker, resolveProjectRootRaw, getPrimaryWorktreeRoot, canonicalizeGitWorktreePath, resolveProjectRoot, isWindowsAbsolutePath, isValidFilePath, normalizePath, isInsideDir, filterTrackableFiles, extractEditedFilesFromPatch, getToolInputText, extractEditedFilesFromHookPayload, getTurnStateKey, mergeFiles };
