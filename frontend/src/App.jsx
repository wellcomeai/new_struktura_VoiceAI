import React, { useState, useCallback } from 'react';
import { useAuth } from './hooks/useAuth';
import Navbar from './components/Navbar';
import SphereAnimation from './components/SphereAnimation';
import AuthSection from './components/AuthSection/AuthSection';
import UseCasesSection from './components/UseCasesSection';
import PricingSection from './components/PricingSection';
import Footer from './components/Footer';

function App() {
  const [activeTab, setActiveTab] = useState('register');

  useAuth();

  const handleCtaClick = useCallback((e) => {
    e.preventDefault();
    setActiveTab('register');
    const authSection = document.querySelector('.auth-section');
    if (authSection) {
      authSection.scrollIntoView({ behavior: 'smooth' });
    }
  }, []);

  return (
    <div className="page-wrapper">
      <div className="content-wrapper">
        <div className="main-container">
          <div className="presentation-section">
            <Navbar />
            <SphereAnimation />
            <div className="presentation-content">
              <h1 className="main-title">Ваш голосовой ИИ.</h1>
              <h2 className="subtitle">Говорит. Слушает. Понимает.</h2>
              <p className="description">
                Создавайте голосовых ассистентов на основе OpenAI за минуты. Загружайте базы знаний, интегрируйте на сайт или в приложение одним кликом.
              </p>
              <a
                href="#register"
                className="btn btn-primary btn-large"
                onClick={handleCtaClick}
              >
                Создать первого бота
              </a>
            </div>
          </div>

          <AuthSection activeTab={activeTab} setActiveTab={setActiveTab} />
        </div>

        <UseCasesSection />
        <PricingSection />
      </div>

      <Footer />
    </div>
  );
}

export default App;
