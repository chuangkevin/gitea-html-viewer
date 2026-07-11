import React from "react";
import ReactDOM from "react-dom/client";
import { BrowserRouter, Routes, Route } from "react-router-dom";
import "./index.css";
import Home from "./pages/Home";
import Workspace from "./pages/Workspace";
import SharePage from "./pages/SharePage";
import SlidesPage from "./pages/SlidesPage";

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <BrowserRouter>
      <Routes>
        <Route path="/" element={<Home />} />
        <Route path="/edit/:owner/:repo" element={<Workspace />} />
        <Route path="/s/:token" element={<SharePage />} />
        <Route path="/s/:token/slides" element={<SlidesPage />} />
      </Routes>
    </BrowserRouter>
  </React.StrictMode>
);
