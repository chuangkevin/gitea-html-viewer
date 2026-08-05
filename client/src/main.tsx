import React from "react";
import ReactDOM from "react-dom/client";
import { BrowserRouter, Routes, Route } from "react-router-dom";
import "./index.css";
import Home from "./pages/Home";
import Workspace from "./pages/Workspace";
import SharePage from "./pages/SharePage";
import SlidesPage from "./pages/SlidesPage";
import DirectSlidesPage from "./pages/DirectSlidesPage";
import PresentPage from "./pages/PresentPage";
import Admin from "./pages/Admin";

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <BrowserRouter>
      <Routes>
        <Route path="/" element={<Home />} />
        <Route path="/edit/:provider/:project" element={<Workspace />} />
        <Route path="/s/:token" element={<SharePage />} />
        <Route path="/s/:token/slides" element={<SlidesPage />} />
        <Route path="/p/:provider/:project/*" element={<DirectSlidesPage />} />
        <Route path="/present/:provider/:project" element={<PresentPage />} />
        <Route path="/admin" element={<Admin />} />
      </Routes>
    </BrowserRouter>
  </React.StrictMode>
);
