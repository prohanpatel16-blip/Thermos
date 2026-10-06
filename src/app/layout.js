import { Montserrat } from "next/font/google";
import "./globals.css";

const montserrat = Montserrat({
  subsets: ["latin"],
  variable: "--font-montserrat",
  display: "swap",
});

export const metadata = {
  title: "THERMOS — Heatwave Early Warning",
  description:
    "Extreme Heatwave Early Warning and Human Thermal Stress Index for India",
};

export default function RootLayout({ children }) {
  return (
    <html lang="en" className={`${montserrat.variable} h-full`}>
      <body className="min-h-full flex flex-col font-[family-name:var(--font-montserrat)] antialiased">
        {children}
      </body>
    </html>
  );
}
