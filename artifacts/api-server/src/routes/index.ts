import { Router, type IRouter } from "express";
import healthRouter from "./health";
import { geminiRouter } from "./gemini";
import { voicemapRouter } from "./voicemap";
import { audioRouter } from "./audio";
import { renderRouter } from "./render";

const router: IRouter = Router();

router.use(healthRouter);
router.use(geminiRouter);
router.use(voicemapRouter);
router.use(audioRouter);
router.use(renderRouter);

export default router;
