import fs from "node:fs";
import path from "node:path";
import { Router, type NextFunction, type Request, type Response } from "express";
import multer from "multer";
import { ApiError, sendError } from "./http";
import { dataDir, getFileRow, insertFileRow, newId } from "./store";

/**
 * File uploads per API doc §6: multipart field `file`, 25 MB, pdf/png/jpg
 * only. Stored at data/uploads/<fileId>/<name> — deliberately OUTSIDE the
 * static-served public/ dir, and on the same disk agents-mcp reads from, so
 * a file id can be resolved to an absolute host path for `pdf_path` inputs
 * and chat attachments.
 */

const MAX_BYTES = 25 * 1024 * 1024;

const ALLOWED: Record<string, string> = {
  ".pdf": "application/pdf",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
};

export function uploadsDir(): string {
  return path.join(dataDir(), "uploads");
}

function sanitizeName(original: string): string {
  const base = path.basename(original || "upload").replace(/[^\w.() -]+/g, "_");
  return base.length > 0 && base !== "." && base !== ".." ? base : "upload";
}

// Memory storage: 25 MB max at low concurrency, and a rejected upload never
// leaves a stray temp file behind.
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_BYTES, files: 1 },
});

export const filesRouter = Router();

filesRouter.post(
  "/api/files",
  (req: Request, res: Response, next: NextFunction) => {
    upload.single("file")(req, res, (err: unknown) => {
      if (err) {
        const message =
          err instanceof multer.MulterError && err.code === "LIMIT_FILE_SIZE"
            ? "Only pdf/png/jpg up to 25 MB"
            : `Upload failed: ${(err as Error).message}`;
        return sendError(res, 400, "validation", message);
      }
      next();
    });
  },
  (req: Request, res: Response) => {
    const file = req.file;
    if (!file) {
      return sendError(res, 400, "validation", 'multipart field "file" is required');
    }
    const name = sanitizeName(file.originalname);
    const ext = path.extname(name).toLowerCase();
    const contentType = ALLOWED[ext];
    if (!contentType) {
      return sendError(res, 400, "validation", "Only pdf/png/jpg up to 25 MB");
    }

    const id = newId("file");
    const dir = path.join(uploadsDir(), id);
    fs.mkdirSync(dir, { recursive: true });
    const absPath = path.join(dir, name);
    fs.writeFileSync(absPath, file.buffer);

    const row = insertFileRow({
      id,
      userEmail: req.user!.email,
      name,
      size: file.size,
      contentType,
      path: absPath,
    });
    res.status(201).json({
      id: row.id,
      name: row.name,
      size: row.size,
      contentType: row.content_type,
      uploadedAt: row.uploaded_at,
    });
  }
);

filesRouter.get("/api/files/:id", (req: Request, res: Response) => {
  const row = getFileRow(String(req.params.id), req.user!.email);
  if (!row || !fs.existsSync(row.path)) {
    return sendError(res, 404, "not_found", `No such file: ${req.params.id}`);
  }
  res.download(row.path, row.name);
});

/** Resolve a user's file id to its row, for job inputs / chat attachments. */
export function requireOwnedFile(userEmail: string, fileId: string) {
  const row = getFileRow(fileId, userEmail);
  if (!row) throw new ApiError(400, "validation", `Unknown file id: ${fileId}`);
  return row;
}
