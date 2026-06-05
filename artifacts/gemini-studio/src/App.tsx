import { Switch, Route, Router as WouterRouter } from "wouter";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { Toaster } from "@/components/ui/toaster";
import { TooltipProvider } from "@/components/ui/tooltip";
import NotFound from "@/pages/not-found";
import { VideoUploader } from "@/components/video-uploader";
import ScriptPage from "@/pages/script-page";
import VoicePage from "@/pages/voice-page";
import SilencePage from "@/pages/silence-page";
import MoviePage from "@/pages/movie-page";
import VoiceMapPage from "@/pages/voicemap-page";
import JsonMapPage from "@/pages/jsonmap-page";
import RenderPage from "@/pages/render-page";

const queryClient = new QueryClient();

function Router() {
  return (
    <Switch>
      <Route path="/" component={VideoUploader} />
      <Route path="/script" component={ScriptPage} />
      <Route path="/voice" component={VoicePage} />
      <Route path="/silence" component={SilencePage} />
      <Route path="/movie" component={MoviePage} />
      <Route path="/voicemap" component={VoiceMapPage} />
      <Route path="/jsonmap" component={JsonMapPage} />
      <Route path="/render" component={RenderPage} />
      <Route component={NotFound} />
    </Switch>
  );
}

function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <TooltipProvider>
        <WouterRouter base={import.meta.env.BASE_URL.replace(/\/$/, "")}>
          <Router />
        </WouterRouter>
        <Toaster />
      </TooltipProvider>
    </QueryClientProvider>
  );
}

export default App;
